import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cmpStamp,
  mergeShape,
  mergeOp,
  flatten,
  applyPatch,
  isVisible,
  maxVersion,
  shapesEqual,
  opFingerprint,
} from '../shared/merge.js';

const OP_A = '11111111-1111-4111-8111-111111111111';
const OP_B = '22222222-2222-4222-8222-222222222222';
const OP_C = '33333333-3333-4333-8333-333333333333';
const SID = '99999999-9999-4999-8999-999999999999';

/** 便捷构造：fields = { x: [val, ver, clientId, opId] } */
function shape(type, fields) {
  const out = { id: SID, type, fields: {} };
  for (const [name, [val, v, c, o]] of Object.entries(fields)) {
    out.fields[name] = { val, v, c, o };
  }
  return out;
}

function op(kind, patch, { ver, clientId, opId, shapeType }) {
  return { kind, target: SID, shapeType, ver, clientId, opId, patch };
}

test('cmpStamp 是全序：version → clientId → opId', () => {
  assert.equal(cmpStamp({ v: 1, c: 'aa', o: OP_A }, { v: 2, c: 'aa', o: OP_A }), -1);
  assert.equal(cmpStamp({ v: 2, c: 'ab', o: OP_A }, { v: 2, c: 'aa', o: OP_A }), 1);
  assert.equal(cmpStamp({ v: 2, c: 'aa', o: OP_B }, { v: 2, c: 'aa', o: OP_A }), 1);
  assert.equal(cmpStamp({ v: 2, c: 'aa', o: OP_A }, { v: 2, c: 'aa', o: OP_A }), 0);
});

test('同一字段并发写入：戳大者胜，且与到达顺序无关', () => {
  const base = shape('rect', { x: [10, 1, 'client-a', OP_A] });
  const fromA = shape('rect', { x: [100, 2, 'client-a', OP_A] });
  const fromB = shape('rect', { x: [200, 2, 'client-b', OP_B] });

  const aThenB = mergeShape(mergeShape(base, fromA), fromB);
  const bThenA = mergeShape(mergeShape(base, fromB), fromA);

  // client-b > client-a，同版本时字典序大者胜
  assert.equal(flatten(aThenB).x, 200);
  assert.equal(flatten(bThenA).x, 200);
  assert.ok(shapesEqual(aThenB, bThenA), '两种到达顺序必须收敛到同一状态');
});

test('并发修改不同字段：两个操作都保留（字段级 LWW 的核心价值）', () => {
  const base = shape('rect', {
    x: [10, 1, 'client-a', OP_A],
    fill: ['#ffffff', 1, 'client-a', OP_A],
  });
  const moveByB = shape('rect', { x: [400, 2, 'client-b', OP_B], fill: ['#ffffff', 1, 'client-a', OP_A] });
  const paintByA = shape('rect', { x: [10, 1, 'client-a', OP_A], fill: ['#ff0000', 2, 'client-a', OP_C] });

  const merged = mergeShape(mergeShape(base, moveByB), paintByA);
  const flat = flatten(merged);
  assert.equal(flat.x, 400, 'B 的移动保留');
  assert.equal(flat.fill, '#ff0000', 'A 的改色也保留');
});

test('合并满足交换律、结合律、幂等性', () => {
  const s1 = shape('rect', { x: [1, 1, 'aa', OP_A], y: [1, 1, 'aa', OP_A] });
  const s2 = shape('rect', { x: [2, 2, 'bb', OP_B] });
  const s3 = shape('rect', { x: [3, 3, 'cc', OP_C], fill: ['#00ff00', 1, 'cc', OP_C] });

  const left = mergeShape(mergeShape(mergeShape(s1, s2), s3), s2);
  const right = mergeShape(mergeShape(mergeShape(s1, s3), s2), s2);
  assert.ok(shapesEqual(left, right), '交换律');

  const grouped = mergeShape(s1, mergeShape(s2, s3));
  assert.ok(shapesEqual(left, grouped), '结合律');

  assert.ok(shapesEqual(mergeShape(left, left), left), '幂等性');
});

test('墓碑：删除版本更高时图形不可见，后续更高版本可复活', () => {
  const alive = shape('ellipse', { x: [0, 3, 'aa', OP_A], deleted: [false, 3, 'aa', OP_A] });
  const tomb = shape('ellipse', { x: [0, 3, 'aa', OP_A], deleted: [true, 2, 'bb', OP_B] });
  assert.equal(isVisible(mergeShape(alive, tomb)), true, '低版本删除不能覆盖高版本存活');

  const tombNewer = shape('ellipse', { deleted: [true, 9, 'bb', OP_B] });
  assert.equal(isVisible(mergeShape(alive, tombNewer)), false, '更高版本删除生效');

  const revive = shape('ellipse', { deleted: [false, 12, 'cc', OP_C] });
  assert.equal(isVisible(mergeShape(mergeShape(alive, tombNewer), revive)), true, '更高版本可复活');
});

test('墓碑参与比较：陈旧 update 无法把已删除图形翻回来', () => {
  const tomb = shape('rect', { deleted: [true, 10, 'aa', OP_A], x: [5, 10, 'aa', OP_A] });
  const staleEdit = shape('rect', { x: [900, 4, 'bb', OP_B], deleted: [false, 4, 'bb', OP_B] });
  const merged = mergeShape(tomb, staleEdit);
  assert.equal(isVisible(merged), false);
  assert.equal(flatten(merged).x, 5);
});

test('authoritative 模式在戳相等时采用服务端值（吸收归一化结果）', () => {
  const local = shape('rect', { x: [1e9, 2, 'aa', OP_A] }); // 客户端乐观值
  const server = shape('rect', { x: [100000, 2, 'aa', OP_A] }); // 服务端 clamp 后的值，戳相同
  assert.equal(flatten(mergeShape(local, server)).x, 1e9, '非权威模式保留本地');
  assert.equal(
    flatten(mergeShape(local, server, { authoritative: true })).x,
    100000,
    '权威模式必须采用服务端归一化值，否则两端永久分叉',
  );
});

test('mergeOp 幂等：同一条 op 应用多次结果不变', () => {
  const base = shape('rect', { x: [0, 1, 'aa', OP_A], y: [0, 1, 'aa', OP_A] });
  const o = op('patch', { x: 50, y: 60 }, { ver: 2, clientId: 'bb', opId: OP_B });
  const once = mergeOp(base, o);
  const thrice = mergeOp(mergeOp(mergeOp(base, o), o), o);
  assert.ok(shapesEqual(once, thrice));
  assert.equal(flatten(once).x, 50);
});

test('陈旧的离线 op 被拒：低版本不会覆盖高版本', () => {
  const current = shape('rect', { x: [800, 20, 'aa', OP_A] });
  const stale = op('patch', { x: 10 }, { ver: 11, clientId: 'bb', opId: OP_B });
  const merged = mergeOp(current, stale);
  assert.equal(flatten(merged).x, 800);
  assert.ok(shapesEqual(merged, current));
});

test('applyPatch 忽略白名单外字段，flatten 为缺失字段补默认值', () => {
  const s = applyPatch(null, { x: 1, y: 2, w: 30, h: 40, hack: 'x' }, {
    v: 1, c: 'aa', o: OP_A, target: SID, type: 'rect',
  });
  assert.equal(s.fields.hack, undefined);
  const flat = flatten(s);
  assert.equal(flat.x, 1);
  assert.equal(flat.fill, '#ffffff');
  assert.equal(flat.deleted, false);
  assert.equal(maxVersion(s), 1);
});

test('opFingerprint 区分不同 payload，相同 payload 稳定', () => {
  const a = op('patch', { x: 1, y: 2 }, { ver: 2, clientId: 'aa', opId: OP_A });
  const b = op('patch', { y: 2, x: 1 }, { ver: 2, clientId: 'aa', opId: OP_A });
  const c = op('patch', { x: 1, y: 3 }, { ver: 2, clientId: 'aa', opId: OP_A });
  assert.equal(opFingerprint(a), opFingerprint(b));
  assert.notEqual(opFingerprint(a), opFingerprint(c));
});
