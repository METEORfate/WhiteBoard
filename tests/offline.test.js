import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { newClient, sleep, startServer, stopServer, uuid, waitUntil } from './helpers.js';

let port;

before(async () => {
  port = await startServer();
});

after(async () => {
  await stopServer();
});

/**
 * 模拟「断网 → 本地继续编辑 → 恢复 → 自动重放」的完整链路。
 * 离线队列在浏览器端是 localStorage，这里等价地用一个数组表示。
 */
test('断网期间的操作在重连后自动同步（队列重放）', async () => {
  const room = 'offline-replay';
  const a = await newClient(port, room, { name: 'A' });
  const b = await newClient(port, room, { name: 'B' });

  const { id: baseId } = await a.createShape({ x: 0, y: 0 });
  await waitUntil(() => b.shape(baseId), { label: 'B 收到初始图形' });

  // ── A 断网 ──
  const identity = { clientId: a.clientId, sessionEpoch: a.sessionEpoch, clientSeq: a.clientSeq };
  a.close();
  await sleep(50);

  // 断网期间 A 继续画 3 个图形（只写本地队列，不发送）
  const queue = [];
  for (let i = 0; i < 3; i += 1) {
    a.clientSeq += 1;
    queue.push(
      a.buildOp({
        kind: 'create',
        target: uuid(),
        shapeType: 'rect',
        ver: 1,
        patch: { x: 10 * i, y: 10 * i, w: 40, h: 40, deleted: false },
      }),
    );
  }
  assert.equal(b.visible().length, 1, '断网期间对端看不到新图形');

  // ── A 恢复网络：重新握手 + 重放队列 ──
  const a2 = await newClient(port, room, { ...identity, name: 'A' });
  assert.equal(a2.welcome.shapes.length, 1, '快照里只有已同步的图形');

  for (const op of queue) {
    const ack = await a2.sendRawOp(op);
    assert.equal(ack.accepted, true, '离线操作应被接受');
  }

  await waitUntil(() => b.visible().length === 4, { label: 'B 收到全部离线操作' });
  await sleep(100);
  assert.equal(a2.visible().length, 4, 'A 本地也是 4 个图形');
  assert.equal(b.gaps, 0, '对端 serverSeq 无缺口');

  a2.close();
  b.close();
});

test('重放已应用过的 op：幂等去重，不会重复创建', async () => {
  const room = 'offline-dup-replay';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const target = uuid();
  const op = a.buildOp({
    kind: 'create',
    target,
    shapeType: 'ellipse',
    ver: 1,
    patch: { x: 1, y: 1, w: 20, h: 20, deleted: false },
  });
  a.clientSeq += 1;
  await a.sendRawOp(op);

  // 模拟「ack 丢失后重连重放」：同一个 op 再发两次
  const replay1 = await a.sendRawOp(op);
  const replay2 = await a.sendRawOp(op);
  assert.equal(replay1.duplicate, true);
  assert.equal(replay2.duplicate, true);

  await waitUntil(() => b.shape(target), { label: 'B 收到一次' });
  await sleep(100);
  assert.equal(b.visible().length, 1, '只应存在一个图形');
  a.close();
  b.close();
});

test('离线编辑遇到在线端更高版本：服务端纠正，两端收敛', async () => {
  const room = 'offline-starvation';
  const a = await newClient(port, room, { name: 'A' });
  const b = await newClient(port, room, { name: 'B' });

  const { id } = await a.createShape({ x: 0, y: 0 });
  await waitUntil(() => b.shape(id), { label: 'B 收到' });

  // A 断网，基于 ver=1 继续改
  const identity = { clientId: a.clientId, sessionEpoch: a.sessionEpoch, clientSeq: a.clientSeq };
  a.close();
  a.clientSeq += 1;
  const offlineOp = a.buildOp({ kind: 'patch', target: id, patch: { x: 111 }, ver: 2 });

  // 在线端连续改 5 次，把版本推到 6
  for (let v = 2; v <= 6; v += 1) {
    await b.patchShape(id, { x: 500 + v }, v);
  }
  await sleep(80);

  // A 重连并重放落后的 op
  const a2 = await newClient(port, room, { ...identity, name: 'A' });
  const ack = await a2.sendRawOp(offlineOp);

  assert.equal(ack.accepted, false, '落后的离线 op 不应被接受');
  assert.equal(ack.shape.fields.x.val, 506, 'ack 带回服务端权威值，供客户端自我纠正');
  assert.equal(ack.shape.fields.x.v, 6);

  await sleep(100);
  assert.equal(b.shape(id).fields.x.val, 506);
  assert.equal(a2.shape(id).fields.x.val, 506, 'A 收到权威态后覆盖本地乐观值');

  a2.close();
  b.close();
});

test('离线 create 后立刻 delete：不留可见图形', async () => {
  const room = 'offline-create-delete';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const identity = { clientId: a.clientId, sessionEpoch: a.sessionEpoch, clientSeq: a.clientSeq };
  a.close();

  const target = uuid();
  a.clientSeq += 1;
  const createOp = a.buildOp({
    kind: 'create',
    target,
    shapeType: 'text',
    ver: 1,
    patch: { x: 0, y: 0, w: 80, h: 30, text: 'hi', deleted: false },
  });
  a.clientSeq += 1;
  const deleteOp = a.buildOp({ kind: 'delete', target, patch: { deleted: true }, ver: 2 });

  const a2 = await newClient(port, room, { ...identity });
  await a2.sendRawOp(createOp);
  const delAck = await a2.sendRawOp(deleteOp);
  assert.equal(delAck.accepted, true);

  await sleep(120);
  assert.equal(a2.visible().length, 0, 'A 看不到');
  assert.equal(b.visible().length, 0, 'B 也看不到');
  assert.ok(a2.shape(target), '墓碑保留，供后续撤销/复活');

  a2.close();
  b.close();
});

test('断线重连期间对端持续写入：重连后不丢帧', async () => {
  const room = 'offline-busy';
  const a = await newClient(port, room);
  const b = await newClient(port, room);

  const identity = { clientId: a.clientId, sessionEpoch: a.sessionEpoch, clientSeq: a.clientSeq };
  a.close();

  // B 在 A 断线期间写 20 个图形
  for (let i = 0; i < 20; i += 1) await b.createShape({ x: i * 5, y: i * 5 });
  await sleep(100);

  const a2 = await newClient(port, room, { ...identity });
  assert.equal(a2.welcome.shapes.length, 20, '快照包含全部 20 个图形');
  assert.equal(a2.gaps, 0);

  a2.close();
  b.close();
});
