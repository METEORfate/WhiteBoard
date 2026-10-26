/**
 * 客户端 DocStore 的单元测试。
 *
 * 这一层原本只有端到端测试覆盖，代价是：applyRemote 传错函数（把 shape 当成 op）
 * 会让浏览器里所有实时同步静默失效，而纯服务端测试全绿。这里把它钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// 必须在 import store 之前装好 localStorage 替身
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const { DocStore } = await import('../client/js/store.js');
const { uuid } = await import('../shared/ids.js');
const { mergeOp, flatten } = await import('../shared/merge.js');

let seq = 0;
function makeStore(over = {}) {
  seq += 1;
  return new DocStore({
    roomId: `unit-${seq}`,
    clientId: `c-unit${String(seq).padStart(4, '0')}`,
    sessionEpoch: `ep-unit-${seq}`,
    ...over,
  });
}

function shapeFromOp(op) {
  return mergeOp(null, op);
}

test('创建图形：本地立即生效、入队、可序列化', () => {
  const store = makeStore();
  const { id, op } = store.createShape({ type: 'rect', x: 10, y: 20, w: 100, h: 80, fill: '#ff0000' });

  assert.equal(store.list().length, 1);
  assert.equal(flatten(store.getShape(id)).x, 10);
  assert.equal(store.pending.length, 1);
  assert.equal(op.kind, 'create');
  assert.equal(op.shapeType, 'rect');
  assert.equal(op.ver, 1);
  assert.equal(store.pending[0].opId, op.opId);
});

test('applyRemote 能把远端图形合并进本地（回归：曾误用 mergeOp 导致抛异常）', () => {
  const store = makeStore();
  const remoteOp = {
    opId: uuid(),
    kind: 'create',
    target: uuid(),
    shapeType: 'ellipse',
    ver: 1,
    clientId: 'c-remote001',
    patch: { x: 5, y: 6, w: 30, h: 40, fill: '#00ff00', deleted: false, z: 1 },
  };
  const remoteShape = shapeFromOp(remoteOp);

  assert.doesNotThrow(() => store.applyRemote(remoteShape));
  assert.equal(store.list().length, 1);
  const flat = flatten(store.getShape(remoteOp.target));
  assert.equal(flat.x, 5);
  assert.equal(flat.type, 'ellipse');
});

test('applyRemote 逐字段合并：远端更高版本覆盖，本地更新的字段保留', () => {
  const store = makeStore();
  const { id } = store.createShape({ type: 'rect', x: 0, y: 0, w: 50, h: 50 });

  // 本地再改一次颜色 → ver 2
  store.applyLocal(id, { fill: '#123456' });

  // 远端基于 ver1 改了位置 → ver 2，clientId 更大，应该赢
  const remoteShape = {
    id,
    type: 'rect',
    fields: {
      x: { val: 300, v: 2, c: 'c-zzzzzzzzz', o: uuid() },
      y: { val: 300, v: 2, c: 'c-zzzzzzzzz', o: uuid() },
    },
  };
  store.applyRemote(remoteShape);

  const flat = flatten(store.getShape(id));
  assert.equal(flat.x, 300, '远端更高戳的位置生效');
  assert.equal(flat.fill, '#123456', '本地更新的颜色不被旧数据覆盖');
});

test('撤销/重做：生成新 op 而不是重放旧 op', () => {
  const store = makeStore();
  const { id } = store.createShape({ type: 'rect', x: 0, y: 0, w: 40, h: 40 });
  store.applyLocal(id, { x: 200 });

  assert.equal(flatten(store.getShape(id)).x, 200);
  assert.equal(store.canUndo(), true);

  store.undo();
  assert.equal(flatten(store.getShape(id)).x, 0, '撤销回到原位置');
  assert.equal(store.canRedo(), true);

  store.redo();
  assert.equal(flatten(store.getShape(id)).x, 200, '重做回到新位置');

  // 每次撤销/重做都是一条新 op，版本号持续递增
  const vers = store.pending.map((op) => op.ver);
  assert.deepEqual([...vers].sort((a, b) => a - b), vers, 'ver 单调递增');
  assert.equal(new Set(store.pending.map((op) => op.opId)).size, store.pending.length, 'opId 不重复');
});

test('删除是墓碑：不可见但保留记录，撤销可复活', () => {
  const store = makeStore();
  const { id } = store.createShape({ type: 'text', x: 0, y: 0, w: 60, h: 24 });
  store.deleteShape(id);

  assert.equal(store.list().length, 0);
  assert.ok(store.getShape(id), '墓碑仍在');
  assert.equal(flatten(store.getShape(id)).deleted, true);

  store.undo();
  assert.equal(store.list().length, 1, '撤销删除后可见');
  assert.equal(flatten(store.getShape(id)).deleted, false);
});

test('快照覆盖后会把未同步队列重新叠回本地（避免闪一下再出现）', () => {
  const store = makeStore();
  const { id } = store.createShape({ type: 'rect', x: 1, y: 2, w: 10, h: 10 });
  const pendingBefore = store.pending.length;
  assert.equal(pendingBefore, 1);

  // 服务端快照里还没有这个图形
  store.replaceAll([]);
  assert.equal(store.list().length, 1, '待同步的本地图形要留在画布上');
  assert.equal(flatten(store.getShape(id)).x, 1);
});

test('刷新页面后能从本地缓存恢复文档与队列', () => {
  const roomId = 'unit-persist';
  const a = new DocStore({ roomId, clientId: 'c-persist001', sessionEpoch: 'ep-persist' });
  const { id } = a.createShape({ type: 'ellipse', x: 7, y: 8, w: 20, h: 20 });
  // 立即落盘（正常是 120ms 防抖）
  a.flush();

  const b = new DocStore({ roomId, clientId: 'c-persist001', sessionEpoch: 'ep-persist' });
  assert.equal(b.list().length, 1, '文档缓存恢复');
  assert.equal(flatten(b.getShape(id)).x, 7);
  assert.equal(b.pending.length, 1, '队列恢复');
  assert.ok(b.clientSeq >= 1, 'clientSeq 接着用，不会重置成 0');
});

test('dequeue 只移除对应 op', () => {
  const store = makeStore();
  const a = store.createShape({ type: 'rect', x: 0, y: 0, w: 10, h: 10 });
  const b = store.createShape({ type: 'rect', x: 20, y: 0, w: 10, h: 10 });
  assert.equal(store.pending.length, 2);

  store.dequeue(a.op.opId);
  assert.equal(store.pending.length, 1);
  assert.equal(store.pending[0].opId, b.op.opId);
});

test('非法远端图形被丢弃且不影响本地状态', () => {
  const store = makeStore();
  store.createShape({ type: 'rect', x: 0, y: 0, w: 10, h: 10 });

  assert.equal(store.applyRemote({ id: 'bad', type: 'rect', fields: {} }), false);
  assert.equal(store.applyRemote(null), false);
  assert.equal(store.list().length, 1);
});
