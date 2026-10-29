/**
 * 远端光标合并与 clientSeq 高水位上限的回归测试。
 *
 * 这两项都是「长期运行才暴露」的问题：
 *   1. 逐帧广播 presence 在多人房间里是纯带宽浪费，合并窗口必须真的合并；
 *   2. hwm 每条重连新增一条 key，不封顶就是一条只增不减的内存曲线。
 * 同时要守住两条容易踩坏的边界：窗口里的光标不能在人走后继续发光，
 * 房间空了不能留下定时器（否则空闲回收形同虚设）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newClient,
  rooms,
  sleep,
  startServer,
  stopServer,
  uuid,
  waitUntil,
} from './helpers.js';
import { CONFIG } from '../server/config.js';

const port = await startServer();

test.after(async () => {
  await stopServer();
});

function roomIdOf(tag) {
  return `${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 某个观察者收到的、来自指定客户端的光标移动帧 */
function movesFrom(observer, clientId) {
  return observer.inbox.filter(
    (m) => m.type === 'presence' && m.event === 'move' && m.clientId === clientId,
  );
}

test('50ms 窗口内多条 presence 只广播一次，内容是最后一条位置', async () => {
  const roomId = roomIdOf('presence-batch');
  const a = await newClient(port, roomId, { name: 'A' });
  const b = await newClient(port, roomId, { name: 'B' });
  await waitUntil(
    () => a.inbox.some((m) => m.type === 'presence' && m.event === 'join' && m.clientId === b.clientId),
    { label: 'A 收到 B 的 join' },
  );

  // 一次鼠标拖动：连续 8 帧，全部落在同一个窗口里
  for (let i = 1; i <= 8; i += 1) {
    b.conn.send({ type: 'presence', cursor: { x: i, y: i * 2 } });
  }
  await sleep(150);

  const got = movesFrom(a, b.clientId);
  assert.equal(got.length, 1, '8 次移动必须合并成 1 帧');
  assert.deepEqual(got[0].cursor, { x: 8, y: 16 }, '窗口里只保留最新位置');
  assert.equal(got[0].name, 'B');
  assert.ok(got[0].color, '合并后仍要带上展示色，客户端不改也能正常渲染');

  a.close();
  b.close();
  await sleep(80);
});

test('同一窗口内多个客户端各自只广播一次最新位置', async () => {
  const roomId = roomIdOf('presence-multi');
  const a = await newClient(port, roomId, { name: 'A' });
  const b = await newClient(port, roomId, { name: 'B' });
  const watcher = await newClient(port, roomId, { name: 'W' });
  // 三个 hello 都已 await 过，成员表已稳定；只等 join 广播落地，避免它混进后面的统计
  await sleep(30);

  for (let i = 1; i <= 5; i += 1) {
    a.conn.send({ type: 'presence', cursor: { x: i, y: 0 } });
    b.conn.send({ type: 'presence', cursor: { x: 0, y: i } });
  }
  await sleep(150);

  const fromA = movesFrom(watcher, a.clientId);
  const fromB = movesFrom(watcher, b.clientId);
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  assert.deepEqual(fromA[0].cursor, { x: 5, y: 0 });
  assert.deepEqual(fromB[0].cursor, { x: 0, y: 5 });

  a.close();
  b.close();
  watcher.close();
  await sleep(80);
});

test('窗口内断线的连接，其待发光标被丢弃，不会留下幽灵光标', async () => {
  const roomId = roomIdOf('presence-leave');
  const a = await newClient(port, roomId, { name: 'A' });
  const b = await newClient(port, roomId, { name: 'B' });
  await waitUntil(
    () => a.inbox.some((m) => m.type === 'presence' && m.event === 'join' && m.clientId === b.clientId),
    { label: 'A 收到 B 的 join' },
  );

  const room = rooms.get(roomId);
  b.conn.send({ type: 'presence', cursor: { x: 777, y: 888 } });
  // 10ms 足够服务端把这条帧排进窗口，又远小于 50ms 窗口，断线仍发生在 flush 之前
  await sleep(10);
  assert.equal(room.pendingPresence.size, 1, '这条光标应已在窗口里排队');

  b.close();
  await waitUntil(() => room.members.size === 1, { label: 'B 已离开' });
  assert.equal(room.pendingPresence.size, 0, '断线时待发光标必须被丢掉');

  await sleep(150);
  assert.equal(movesFrom(a, b.clientId).length, 0, '已断线的人不能再被广播光标');
  assert.ok(
    a.inbox.some((m) => m.type === 'presence' && m.event === 'leave' && m.clientId === b.clientId),
    '离开事件本身仍要照常广播',
  );

  a.close();
  await sleep(80);
});

test('房间没人后合并定时器被清理，不留 timer', async () => {
  const roomId = roomIdOf('presence-timer');
  const c = await newClient(port, roomId);
  const room = rooms.get(roomId);

  c.conn.send({ type: 'presence', cursor: { x: 1, y: 1 } });
  await waitUntil(() => room.presenceFlushTimer !== null, {
    label: '窗口定时器已建立',
    interval: 5,
    timeout: 1000,
  });

  c.close();
  await waitUntil(() => room.members.size === 0, { label: '连接已断开' });

  assert.equal(room.presenceFlushTimer, null, '最后一个人离开时必须清掉定时器');
  assert.equal(room.pendingPresence.size, 0, '待发帧一并清空');

  // 再等一个窗口：如果定时器没被清掉，这里会看到一次延迟 flush
  await sleep(120);
  assert.equal(room.presenceFlushTimer, null);
  assert.equal(room.pendingPresence.size, 0);
});

test('hwm 超过上限时淘汰最久未使用的会话，仍在使用的会话保留', async () => {
  assert.equal(CONFIG.hwmLimit, 500, '上限按规格固定为 500 条');

  const roomId = roomIdOf('hwm-cap');
  const c = await newClient(port, roomId);
  const room = rooms.get(roomId);

  const clientId = 'c-hwm-bench';
  const conn = { clientId };
  const target = uuid();
  let seq = 0;

  // 直接打到 Room.applyOp：走完整校验 + 幂等 + 高水位路径，只是省掉 500 条连接的开销
  const pushOp = (sessionEpoch) => {
    seq += 1;
    const res = room.applyOp(conn, {
      opId: uuid(),
      roomId,
      clientId,
      sessionEpoch,
      clientSeq: seq,
      kind: 'create',
      target,
      shapeType: 'rect',
      ver: seq,
      patch: { x: seq, y: seq, w: 10, h: 10, deleted: false },
      ts: Date.now(),
    });
    assert.equal(res.ok, true, `第 ${seq} 条 op 应被接受${res.code ? `（${res.code}）` : ''}`);
  };

  const epochOf = (i) => `ep-${String(i).padStart(4, '0')}`;
  for (let i = 0; i < CONFIG.hwmLimit; i += 1) pushOp(epochOf(i));
  assert.equal(room.hwm.size, CONFIG.hwmLimit, '正好装满上限时不淘汰');

  // 用一次最早的那个会话：它应当被移到 LRU 的「最近使用」端
  const hotKey = `${clientId}:${epochOf(0)}`;
  pushOp(epochOf(0));
  assert.equal(room.hwm.get(hotKey), seq);

  // 再塞 20 个新会话，强制淘汰
  for (let i = 0; i < 20; i += 1) pushOp(`ep-new-${i}`);

  assert.equal(room.hwm.size, CONFIG.hwmLimit, '淘汰后仍稳定在上限');
  assert.ok(room.hwm.has(hotKey), '刚用过的会话不能被淘汰');
  assert.equal(room.hwm.has(`${clientId}:${epochOf(1)}`), false, '最久未使用的会话被淘汰');
  assert.ok(room.hwm.has(`${clientId}:ep-new-19`), '新会话保留');

  c.close();
  await sleep(80);
});
