/**
 * 画笔图元（pen）的协议与合并测试。
 *
 * 画笔是本项目里唯一一个「字段值不是标量」的图形，因此单独验证三件事：
 *   1. pts 的校验是白名单式的（越界 clamp、非有限数拒绝、长度封顶）；
 *   2. 扁平视图不会把默认数组或字段数组的引用泄漏出去；
 *   3. 一笔仍然走字段级 LWW——移动一笔与改一笔的颜色是两个不相交字段集，都保留。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeField, normalizeOp, LIMITS } from '../shared/protocol.js';
import { flatten, mergeOp, shapesEqual } from '../shared/merge.js';

const SID = '99999999-9999-4999-8999-999999999999';

function penCreate(over = {}) {
  return {
    opId: '11111111-1111-4111-8111-111111111111',
    roomId: 'demo',
    clientId: 'client-aaaaaa',
    sessionEpoch: 'abc123-def456',
    clientSeq: 1,
    kind: 'create',
    shapeType: 'pen',
    target: SID,
    ver: 1,
    ts: 0,
    patch: { x: 10, y: 20, w: 100, h: 50, pts: [0, 0, 40, 30, 100, 50] },
    ...over,
  };
}

test('pen：pts 越界走 clamp，坐标取整', () => {
  const r = normalizeField('pts', [0, 0, 1e9, -1e9, 10.6, 20.4]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [0, 0, LIMITS.MAX_SIZE, 0, 11, 20]);
});

test('pen：pts 非数组 / 奇数长度 / 非有限数一律拒绝', () => {
  assert.equal(normalizeField('pts', 'a,b').ok, false);
  assert.equal(normalizeField('pts', [0, 0, 10]).ok, false);
  assert.equal(normalizeField('pts', [0, 0, NaN, 10]).ok, false);
  assert.equal(normalizeField('pts', [0, 0, Infinity, 10]).ok, false);
});

test('pen：点数超过上限直接拒绝（不是截断）', () => {
  const tooMany = new Array((LIMITS.MAX_POINTS + 1) * 2).fill(1);
  const r = normalizeField('pts', tooMany);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'POINTS_TOO_MANY');
});

test('pen：create 缺 pts 或只有一个点会被拒', () => {
  assert.equal(normalizeOp(penCreate({ patch: { x: 0, y: 0, w: 10, h: 10 } })).ok, false);
  assert.equal(
    normalizeOp(penCreate({ patch: { x: 0, y: 0, w: 10, h: 10, pts: [1, 1] } })).ok,
    false,
  );
  assert.equal(normalizeOp(penCreate()).ok, true);
});

test('pen：扁平视图给缺失的 pts 一个独立空数组（不共享默认值）', () => {
  const shape = mergeOp(null, normalizeOp(penCreate()).op);
  const a = flatten(shape);
  a.pts.push(123);
  const b = flatten(shape);
  assert.deepEqual(b.pts, [0, 0, 40, 30, 100, 50], '修改扁平视图不应影响原图形');

  // 没有 pts 字段的图形，两次 flatten 也必须拿到互不相干的数组
  const plain = mergeOp(null, normalizeOp({ ...penCreate(), shapeType: 'rect', patch: { x: 0, y: 0, w: 10, h: 10 } }).op);
  const c = flatten(plain);
  c.pts.push(1);
  assert.deepEqual(flatten(plain).pts, []);
});

test('pen：移动一笔与改颜色是两个不相交字段，并发后都保留', () => {
  const base = mergeOp(null, normalizeOp(penCreate()).op);
  const move = {
    opId: '22222222-2222-4222-8222-222222222222',
    target: SID,
    kind: 'patch',
    ver: 2,
    clientId: 'client-aaaaaa',
    patch: { x: 200, y: 300 },
  };
  const recolor = {
    opId: '33333333-3333-4333-8333-333333333333',
    target: SID,
    kind: 'patch',
    ver: 2,
    clientId: 'client-bbbbbb',
    patch: { stroke: '#ff0000' },
  };

  const ab = mergeOp(mergeOp(base, move), recolor);
  const ba = mergeOp(mergeOp(base, recolor), move);

  assert.equal(flatten(ab).x, 200);
  assert.equal(flatten(ab).stroke, '#ff0000');
  assert.deepEqual(flatten(ab).pts, flatten(ba).pts, '两端笔迹必须一致');
  assert.equal(flatten(ba).x, 200);
  assert.equal(flatten(ba).stroke, '#ff0000');
});

test('pen：shapesEqual 按值比较 pts，引用不同但内容相同视为相等', () => {
  const a = mergeOp(null, normalizeOp(penCreate()).op);
  const b = mergeOp(null, normalizeOp(penCreate()).op);
  assert.equal(shapesEqual(a, b), true);

  const moved = mergeOp(
    a,
    normalizeOp(penCreate({ kind: 'patch', ver: 2, opId: '44444444-4444-4444-8444-444444444444', patch: { pts: [0, 0, 50, 50] } })).op,
  );
  assert.equal(shapesEqual(a, moved), false);
});
