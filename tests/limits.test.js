/**
 * 房间级资源与版本约束的单元测试。
 *
 * 这两条都属于「单测全绿但线上会被一条畸形 op 打穿」的类型：
 *   · ver 没有上界 → 一条 ver=1e9 的 op 让图形永久冻结；
 *   · 配额只数可见图形 → 「创建后立刻删除」可以无限绕过上限。
 * 直接构造 Room（不起 socket），把边界钉死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/room.js';
import { LIMITS } from '../shared/protocol.js';
import { newSessionEpoch, uuid } from '../shared/ids.js';

const CONFIG = {
  hwmLimit: 500,
  seenOpLimit: 50_000,
  compactAfterLines: 1e9, // 不触发压缩，store 用假实现
  presenceFlushMs: 50,
};

function makeRoom() {
  const store = {
    append() {},
    lineCount() {
      return 0;
    },
    compact() {},
    has() {
      return true;
    },
  };
  const room = new Room('limits-room', { store, bootEpoch: 1, config: CONFIG });
  const clientId = uuid();
  const conn = { clientId };
  let seq = 0;
  const op = (over) => {
    seq += 1;
    return {
      roomId: 'limits-room',
      clientId,
      sessionEpoch: newSessionEpoch(),
      clientSeq: seq,
      opId: uuid(),
      kind: 'patch',
      target: uuid(),
      ver: 1,
      patch: { x: 0 },
      ts: Date.now(),
      ...over,
    };
  };
  return { room, conn, op };
}

test('ver 跳跃被拒绝：一条 ver=1e9 的 op 不能把图形永久冻结', () => {
  const { room, conn, op } = makeRoom();
  const target = uuid();

  const created = room.applyOp(conn, op({ target, kind: 'create', shapeType: 'rect', patch: { x: 0, y: 0, w: 10, h: 10 } }));
  assert.equal(created.ok, true, '正常创建应被接受');

  const jump = room.applyOp(conn, op({ target, kind: 'patch', ver: 1e9, patch: { x: 5 } }));
  assert.equal(jump.ok, false);
  assert.equal(jump.code, 'VER_TOO_FAR', '版本跳跃必须被拒绝');

  // 关键：拒绝之后图形仍然可改，而不是所有后续 op 都撞 BAD_VERSION
  const normal = room.applyOp(conn, op({ target, kind: 'patch', ver: 2, patch: { x: 5 } }));
  assert.equal(normal.ok, true);
  assert.equal(normal.accepted, true);
  assert.equal(room.shapes.get(target).fields.x.val, 5);
});

test('墓碑计入配额：创建后删除不能无限绕过房间上限', () => {
  const { room, conn, op } = makeRoom();
  const ids = [];

  for (let i = 0; i < LIMITS.MAX_SHAPES_PER_ROOM + 10; i += 1) {
    const id = uuid();
    ids.push(id);
    const created = room.applyOp(conn, op({ target: id, kind: 'create', shapeType: 'rect', patch: { x: 0, y: 0, w: 4, h: 4 } }));
    assert.equal(created.ok, true, `第 ${i} 次创建应被接受`);
    const removed = room.applyOp(conn, op({ target: id, kind: 'delete', ver: 2, patch: { deleted: true } }));
    assert.equal(removed.ok, true, `第 ${i} 次删除应被接受`);
  }

  assert.equal(room.statsView().alive, 0, '全部图形都已删除');
  assert.ok(
    room.shapes.size <= LIMITS.MAX_SHAPES_PER_ROOM,
    `墓碑必须计入配额：shapes.size=${room.shapes.size}，上限=${LIMITS.MAX_SHAPES_PER_ROOM}`,
  );

  // 最老的墓碑一定已经被回收：此时重放它的 create 不能把图形复活
  const revived = room.applyOp(conn, op({ target: ids[0], kind: 'create', shapeType: 'rect', patch: { x: 1, y: 1, w: 4, h: 4 } }));
  assert.equal(revived.ok, false);
  assert.equal(revived.code, 'SHAPE_PRUNED');
  assert.equal(revived.resync, true, '必须让客户端重新拉快照，而不是静默忽略');
});
