import test, { after, before } from 'node:test';
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

let port;

before(async () => {
  port = await startServer();
});

after(async () => {
  await stopServer();
});

test('双客户端实时同步：A 创建图形，B 收到', async () => {
  const room = 'sync-basic';
  const a = await newClient(port, room, { name: 'A' });
  const b = await newClient(port, room, { name: 'B' });

  const { id, ack } = await a.createShape({ x: 40, y: 50 });
  assert.equal(ack.accepted, true);

  await waitUntil(() => b.shape(id), { label: 'B 收到图形' });
  assert.equal(b.shape(id).type, 'rect');
  assert.equal(b.shape(id).fields.x.val, 40);

  a.close();
  b.close();
});

test('移动与编辑都会广播给同房间其他客户端', async () => {
  const room = 'sync-move';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const { id } = await a.createShape({ x: 0, y: 0 });
  await waitUntil(() => b.shape(id), { label: 'B 收到 create' });

  await a.patchShape(id, { x: 300, y: 200 }, 2);
  await waitUntil(() => b.shape(id)?.fields.x?.val === 300, { label: 'B 收到移动' });

  await b.patchShape(id, { fill: '#ff0000' }, 3);
  await waitUntil(() => a.shape(id)?.fields.fill?.val === '#ff0000', { label: 'A 收到改色' });

  a.close();
  b.close();
});

test('并发修改不同字段：两个操作都保留（字段级 LWW）', async () => {
  const room = 'sync-diff-field';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const { id } = await a.createShape({ x: 0, y: 0 });
  await waitUntil(() => b.shape(id), { label: 'B 收到 create' });

  // 两端都基于 ver=1 的同一状态并发修改不同字段
  await Promise.all([a.patchShape(id, { x: 500 }, 2), b.patchShape(id, { fill: '#00ff00' }, 2)]);

  await waitUntil(
    () => a.shape(id)?.fields.x?.val === 500 && a.shape(id)?.fields.fill?.val === '#00ff00',
    { label: 'A 合并两个字段' },
  );
  await waitUntil(
    () => b.shape(id)?.fields.x?.val === 500 && b.shape(id)?.fields.fill?.val === '#00ff00',
    { label: 'B 合并两个字段' },
  );

  a.close();
  b.close();
});

test('并发修改同一字段：按 (version, clientId, opId) 全序裁决，两端一致', async () => {
  const room = 'sync-same-field';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const { id } = await a.createShape({ x: 0, y: 0 });
  await waitUntil(() => b.shape(id), { label: 'B 收到 create' });

  await Promise.all([a.patchShape(id, { x: 111 }, 2), b.patchShape(id, { x: 222 }, 2)]);

  await sleep(150);
  const ax = a.shape(id).fields.x;
  const bx = b.shape(id).fields.x;
  assert.deepEqual(ax, bx, '两端必须收敛到同一字段戳与同一值');
  assert.ok([111, 222].includes(ax.val));

  // 版本号更大的后续写入一定能覆盖
  const winnerClient = ax.c;
  const winner = winnerClient === a.clientId ? a : b;
  await winner.patchShape(id, { x: 999 }, 3);
  await waitUntil(() => a.shape(id).fields.x.val === 999 && b.shape(id).fields.x.val === 999, {
    label: '更高版本覆盖',
  });

  a.close();
  b.close();
});

test('幂等：同一 opId 重复投递只应用一次', async () => {
  const room = 'sync-idempotent';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const target = uuid();
  const op = a.buildOp({
    kind: 'create',
    target,
    shapeType: 'ellipse',
    ver: 1,
    patch: { x: 1, y: 2, w: 30, h: 30, deleted: false },
  });
  a.clientSeq += 1;

  const first = await a.sendRawOp(op);
  assert.equal(first.accepted, true);
  assert.ok(first.seq > 0);

  const roomState = rooms.get(room);
  const seqAfterFirst = roomState.serverSeq;
  const countAfterFirst = a.visible().length;

  // 连发两次同一个 op
  const second = await a.sendRawOp(op);
  const third = await a.sendRawOp(op);

  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.equal(second.seq, null, '重复投递不应再分配 serverSeq');
  assert.equal(roomState.serverSeq, seqAfterFirst, 'serverSeq 不应因重复投递推进');
  assert.equal(a.visible().length, countAfterFirst, '图形数量不变');

  // 对端也只会看到一次
  await waitUntil(() => b.shape(target), { label: 'B 收到 create' });
  await sleep(80);
  assert.equal(b.visible().length, 1);

  a.close();
  b.close();
});

test('同 opId 不同内容被拒绝并要求 resync', async () => {
  const room = 'sync-opid-conflict';
  const a = await newClient(port, room);

  const target = uuid();
  const op = a.buildOp({
    kind: 'create',
    target,
    shapeType: 'rect',
    ver: 1,
    patch: { x: 1, y: 1, w: 10, h: 10, deleted: false },
  });
  a.clientSeq += 1;
  await a.sendRawOp(op);

  // 篡改同一个 opId 的载荷
  const forged = { ...op, patch: { ...op.patch, x: 9999 } };
  a.errors.length = 0;
  await a.sendRawOp(forged).catch(() => null);

  await waitUntil(() => a.errors.some((e) => e.code === 'OPID_CONFLICT'), { label: 'OPID_CONFLICT' });
  await waitUntil(() => a.resyncs > 0, { label: 'resync' });
  assert.equal(a.shape(target).fields.x.val, 1, '服务端状态未被篡改');

  a.close();
});

test('房间隔离：A 房间的 op 不会进入 B 房间', async () => {
  const a = await newClient(port, 'room-alpha');
  const b = await newClient(port, 'room-beta');

  const { id } = await a.createShape({ x: 7, y: 7 });
  await sleep(200);

  assert.equal(b.shapes.size, 0, 'B 房间不应看到 A 房间的图形');
  assert.ok(a.shape(id));

  a.close();
  b.close();
});

test('伪造 roomId 或 clientId 的 op 被拒绝', async () => {
  const a = await newClient(port, 'room-forge-a');
  await newClient(port, 'room-forge-b');

  // 1) 往别的房间发
  const crossRoom = a.buildOp({
    kind: 'create',
    target: uuid(),
    shapeType: 'rect',
    ver: 1,
    patch: { x: 1, y: 1, w: 5, h: 5 },
  });
  crossRoom.roomId = 'room-forge-b';
  a.clientSeq += 1;
  await a.sendRawOp(crossRoom).catch(() => null);
  await waitUntil(() => a.errors.some((e) => e.code === 'ROOM_MISMATCH'), { label: 'ROOM_MISMATCH' });

  // 2) 冒用别人的 clientId
  const forgedClient = a.buildOp({
    kind: 'create',
    target: uuid(),
    shapeType: 'rect',
    ver: 1,
    patch: { x: 1, y: 1, w: 5, h: 5 },
  });
  forgedClient.clientId = 't-deadbeef';
  a.clientSeq += 1;
  await a.sendRawOp(forgedClient).catch(() => null);
  await waitUntil(() => a.errors.some((e) => e.code === 'CLIENT_MISMATCH'), { label: 'CLIENT_MISMATCH' });

  assert.equal(a.visible().length, 0);
  a.close();
});

test('非法数据：拒绝但不断连，房间状态不受影响', async () => {
  const room = 'sync-invalid';
  const a = await newClient(port, room);
  const { id } = await a.createShape({ x: 1, y: 1 });

  const cases = [
    { label: '字符串坐标', op: { ...a.buildOp({ target: id, patch: { x: 'abc' }, ver: 2 }) } },
    { label: 'null 坐标', op: { ...a.buildOp({ target: id, patch: { x: null }, ver: 2 }) } },
    { label: '非法颜色', op: { ...a.buildOp({ target: id, patch: { fill: 'red' }, ver: 2 }) } },
    { label: '超长文本', op: { ...a.buildOp({ target: id, patch: { text: 'x'.repeat(5000) }, ver: 2 }) } },
    { label: '未知 kind', op: { ...a.buildOp({ target: id, patch: { x: 1 }, ver: 2, kind: 'move' }) } },
    { label: '非法 opId', op: { ...a.buildOp({ target: id, patch: { x: 1 }, ver: 2 }), opId: 'nope' } },
    { label: '负版本', op: { ...a.buildOp({ target: id, patch: { x: 1 }, ver: 0 }) } },
  ];

  for (const c of cases) {
    a.errors.length = 0;
    a.clientSeq += 1;
    await a.sendRawOp(c.op).catch(() => null);
    await waitUntil(() => a.errors.length > 0, { label: `${c.label} 被拒绝` });
  }

  // 非 JSON 文本
  a.errors.length = 0;
  a.conn.send('这不是 JSON');
  await waitUntil(() => a.errors.some((e) => e.code === 'BAD_JSON'), { label: 'BAD_JSON' });

  // 连接依然可用
  assert.equal(a.conn.isOpen, true, '非法数据不应断开连接');
  const ok = await a.patchShape(id, { x: 123 }, 2);
  assert.equal(ok.ack.accepted, true, '后续合法 op 仍能处理');

  a.close();
});

test('超大帧触发 1009 关闭，且不影响其他连接', async () => {
  const room = 'sync-oversize';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const closed = new Promise((resolve) => a.conn.on('close', (code) => resolve(code)));
  a.conn.send(JSON.stringify({ type: 'op', op: { padding: 'x'.repeat(80 * 1024) } }));
  const code = await closed;
  assert.equal(code, 1009, '应以 1009 Message Too Big 关闭');

  const { id } = await b.createShape({ x: 1, y: 1 });
  assert.ok(b.shape(id));
  b.close();
});

test('clientSeq 回退触发 resync，而不是静默丢数据', async () => {
  const room = 'sync-seq-reset';
  const a = await newClient(port, room);

  await a.createShape({ x: 1, y: 1 });
  await a.createShape({ x: 2, y: 2 });

  // 模拟本地队列被清空后重新从 1 开始
  a.resyncs = 0;
  a.errors.length = 0;
  const stale = a.buildOp({ kind: 'create', target: uuid(), shapeType: 'rect', ver: 1, patch: { x: 3, y: 3, w: 5, h: 5 } });
  stale.clientSeq = 1;
  await a.sendRawOp(stale).catch(() => null);

  await waitUntil(() => a.errors.some((e) => e.code === 'SEQ_RESET'), { label: 'SEQ_RESET' });
  await waitUntil(() => a.resyncs > 0, { label: 'resync' });
  a.close();
});

test('握手期间到达的广播不会丢失（快照与广播的竞态）', async () => {
  const room = 'sync-snapshot-race';
  const a = await newClient(port, room);

  // 造一批存量图形
  for (let i = 0; i < 5; i += 1) await a.createShape({ x: i * 10, y: 0 });

  // B 加入的同时 A 持续写入
  const joining = newClient(port, room);
  const writing = (async () => {
    for (let i = 0; i < 30; i += 1) {
      await a.createShape({ x: 100 + i, y: 100 });
    }
  })();

  const [b] = await Promise.all([joining, writing]);
  await sleep(200);

  assert.equal(b.gaps, 0, '客户端不应出现 serverSeq 缺口');
  assert.equal(b.visible().length, a.visible().length, '快照 + 增量后两端图形数量一致');

  a.close();
  b.close();
});

test('删除是墓碑：并发删除与移动后两端一致', async () => {
  const room = 'sync-tombstone';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const { id } = await a.createShape({ x: 0, y: 0 });
  await waitUntil(() => b.shape(id), { label: 'B 收到 create' });

  await Promise.all([a.deleteShape(id, 2), b.patchShape(id, { x: 777 }, 2)]);
  await sleep(200);

  assert.equal(a.visible().length, b.visible().length, '两端可见性一致');
  assert.deepEqual(
    a.shape(id).fields.deleted,
    b.shape(id).fields.deleted,
    '墓碑字段戳必须一致',
  );

  a.close();
  b.close();
});
