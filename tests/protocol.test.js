import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeField,
  normalizePatch,
  normalizeOp,
  normalizeShape,
  sanitizeName,
  isValidRoomId,
  LIMITS,
} from '../shared/protocol.js';

const OP_A = '11111111-1111-4111-8111-111111111111';
const SID = '99999999-9999-4999-8999-999999999999';

function baseOp(over = {}) {
  return {
    opId: OP_A,
    roomId: 'demo',
    clientId: 'client-aaaaaa',
    sessionEpoch: 'abc123-def456',
    clientSeq: 1,
    kind: 'patch',
    target: SID,
    ver: 1,
    patch: { x: 10 },
    ...over,
  };
}

test('数值字段：越界走 clamp，取整幂等', () => {
  assert.equal(normalizeField('x', 1e9).value, LIMITS.MAX_COORD);
  assert.equal(normalizeField('x', -1e9).value, -LIMITS.MAX_COORD);
  assert.equal(normalizeField('x', 10.7).value, 11);
  assert.equal(normalizeField('w', 0).value, LIMITS.MIN_SIZE);
  assert.equal(normalizeField('w', 1e6).value, LIMITS.MAX_SIZE);
});

test('数值字段：NaN / Infinity / 字符串一律拒绝', () => {
  for (const bad of [NaN, Infinity, -Infinity, '10', null, undefined, {}]) {
    assert.equal(normalizeField('x', bad).ok, false, `应拒绝 ${String(bad)}`);
  }
});

test('颜色字段：只接受 #rrggbb / #rrggbbaa / transparent', () => {
  assert.equal(normalizeField('fill', '#AABBCC').value, '#aabbcc');
  assert.equal(normalizeField('fill', '#11223344').value, '#11223344');
  assert.equal(normalizeField('fill', 'transparent').ok, true);
  for (const bad of ['red', 'rgb(1,2,3)', '#fff', 'url(x)', 123]) {
    assert.equal(normalizeField('fill', bad).ok, false, `应拒绝 ${String(bad)}`);
  }
});

test('文本字段：按码点计长，超长拒绝', () => {
  assert.equal(normalizeField('text', '你好🙂').ok, true);
  assert.equal(normalizeField('text', 'a'.repeat(LIMITS.MAX_TEXT_LEN)).ok, true);
  assert.equal(normalizeField('text', 'a'.repeat(LIMITS.MAX_TEXT_LEN + 1)).ok, false);
  assert.equal(normalizeField('text', 123).ok, false);
});

test('未知字段被拒绝', () => {
  assert.equal(normalizeField('hack', 1).ok, false);
  assert.equal(normalizePatch({ hack: 1 }).ok, false);
  assert.equal(normalizePatch({}).ok, false);
});

test('patch 字段数上限', () => {
  const patch = {};
  const names = ['x', 'y', 'w', 'h', 'fill', 'stroke', 'strokeWidth', 'text', 'fontSize', 'deleted'];
  for (const n of names) patch[n] = n === 'fill' || n === 'stroke' ? '#000000' : n === 'text' ? 'x' : n === 'deleted' ? false : 1;
  assert.equal(normalizePatch(patch).ok, true);
  patch.extra1 = 1;
  patch.extra2 = 2;
  patch.extra3 = 3;
  assert.equal(normalizePatch(patch).ok, false);
});

test('合法 op 通过校验并被归一化', () => {
  const r = normalizeOp(baseOp());
  assert.equal(r.ok, true);
  assert.equal(r.op.opId, OP_A);
  assert.equal(r.op.patch.x, 10);
});

test('create 必须带 shapeType 与几何字段', () => {
  assert.equal(normalizeOp(baseOp({ kind: 'create', shapeType: 'rect', patch: { x: 1, y: 1, w: 10, h: 10 } })).ok, true);
  assert.equal(normalizeOp(baseOp({ kind: 'create', patch: { x: 1, y: 1, w: 10, h: 10 } })).ok, false, '缺 shapeType');
  assert.equal(normalizeOp(baseOp({ kind: 'create', shapeType: 'star', patch: { x: 1, y: 1, w: 10, h: 10 } })).ok, false);
  assert.equal(normalizeOp(baseOp({ kind: 'create', shapeType: 'rect', patch: { x: 1, y: 1, w: 10 } })).ok, false, '缺 h');
});

test('create 强制 deleted=false，delete 强制 deleted=true', () => {
  const created = normalizeOp(baseOp({ kind: 'create', shapeType: 'text', patch: { x: 1, y: 1, w: 10, h: 10, deleted: true } }));
  assert.equal(created.op.patch.deleted, false);
  const deleted = normalizeOp(baseOp({ kind: 'delete', patch: { deleted: false } }));
  assert.equal(deleted.op.patch.deleted, true);
});

test('op 结构非法时逐项拒绝', () => {
  assert.equal(normalizeOp(null).ok, false);
  assert.equal(normalizeOp([]).ok, false);
  assert.equal(normalizeOp(baseOp({ opId: 'not-uuid' })).ok, false);
  assert.equal(normalizeOp(baseOp({ roomId: '../etc' })).ok, false);
  assert.equal(normalizeOp(baseOp({ clientId: 'a' })).ok, false);
  assert.equal(normalizeOp(baseOp({ clientSeq: 0 })).ok, false);
  assert.equal(normalizeOp(baseOp({ clientSeq: 1.5 })).ok, false);
  assert.equal(normalizeOp(baseOp({ ver: 0 })).ok, false);
  assert.equal(normalizeOp(baseOp({ kind: 'move' })).ok, false);
  assert.equal(normalizeOp(baseOp({ target: 'x' })).ok, false);
});

test('roomId 格式限制', () => {
  assert.equal(isValidRoomId('demo'), true);
  assert.equal(isValidRoomId('a_b-9'), true);
  assert.equal(isValidRoomId(''), false);
  assert.equal(isValidRoomId('a'.repeat(65)), false);
  assert.equal(isValidRoomId('中文'), false);
  assert.equal(isValidRoomId('a/b'), false);
});

test('normalizeShape 校验戳的完整性', () => {
  const good = {
    id: SID,
    type: 'rect',
    fields: { x: { val: 10, v: 1, c: 'client-aaaaaa', o: OP_A } },
  };
  assert.equal(normalizeShape(good).ok, true);
  assert.equal(normalizeShape({ ...good, fields: { x: { val: 10 } } }).ok, false, '缺戳');
  assert.equal(normalizeShape({ ...good, fields: { x: { val: NaN, v: 1, c: 'client-aaaaaa', o: OP_A } } }).ok, false);
  assert.equal(normalizeShape({ ...good, type: 'star' }).ok, false);
  assert.equal(normalizeShape({ ...good, id: 'x' }).ok, false);
  assert.equal(normalizeShape({ ...good, fields: { hack: { val: 1, v: 1, c: 'client-aaaaaa', o: OP_A } } }).ok, false);
});

test('sanitizeName 去掉控制字符并限长', () => {
  assert.equal(sanitizeName('  小明  '), '小明');
  assert.equal(sanitizeName('a\u0000b\u0007c'), 'abc');
  assert.equal(sanitizeName(''), '访客');
  assert.equal(sanitizeName(null), '访客');
  assert.equal([...sanitizeName('x'.repeat(100))].length, LIMITS.MAX_NAME_LEN);
});
