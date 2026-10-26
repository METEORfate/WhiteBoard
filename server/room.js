/**
 * 房间：单房间的权威状态与 op 处理。
 *
 * 服务端在这里扮演三个角色：
 *   1. 序列化点：所有 op 串行处理，给每个被接受的 op 盖一个单调 serverSeq；
 *   2. 幂等去重：opId 见过就回放上次结果，绝不重复应用；
 *   3. 归一化权威：字段越界在这里被 clamp，广播出去的是归一化后的全量图形。
 *
 * 一致性并不依赖服务端「算对」——它依赖客户端侧的逐字段 max 合并（见 shared/merge.js）。
 * 服务端只保证「同一个 op 序列，所有客户端都会算出同一个结果」。
 */

import { LIMITS, MSG, OP_KIND, normalizeOp, presenceColor, sanitizeName } from '../shared/protocol.js';
import { isVisible, mergeOp, opFingerprint, shapesEqual } from '../shared/merge.js';

const MAX_CURSOR = 1e6;

export class Room {
  /**
   * @param {string} id
   * @param {{store: import('./store.js').Store, bootEpoch: string, config: any, log: Function}} deps
   */
  constructor(id, { store, bootEpoch, config, log }) {
    this.id = id;
    this.store = store;
    this.bootEpoch = bootEpoch;
    this.config = config;
    this.log = log || (() => {});

    /** @type {Map<string, object>} shapeId → 带戳图形（含墓碑） */
    this.shapes = new Map();
    this.serverSeq = 0;

    /** `${clientId}:${sessionEpoch}` → 已处理的 clientSeq 高水位 */
    this.hwm = new Map();
    /** opId → 指纹，用于幂等去重与「同 opId 不同 payload」检测 */
    this.seen = new Map();
    /** connId → conn */
    this.members = new Map();
    /** clientId → { clientId, name, color, cursor } */
    this.presence = new Map();

    this.stats = { accepted: 0, duplicates: 0, rejected: 0, resyncs: 0, compactions: 0 };
  }

  load() {
    const { shapes, seq, lines, truncated } = this.store.load(this.id);
    this.shapes = shapes;
    this.serverSeq = seq;
    if (truncated > 0) {
      this.log('warn', `房间 ${this.id} 日志有 ${truncated} 行损坏，已跳过（可能是上次崩溃残留）`);
    }
    this.log('info', `房间 ${this.id} 已加载：${shapes.size} 个图形，serverSeq=${seq}，日志 ${lines} 行`);
    return this;
  }

  // ── 连接生命周期 ──────────────────────────────────────────────

  memberList() {
    return [...this.presence.values()].map(({ clientId, name, color }) => ({ clientId, name, color }));
  }

  /**
   * 加入房间。
   * 先构建快照并发送，再标记 joined —— 中间到达的广播会进 pending 缓冲补发，
   * 避免「客户端先收到新 op、又被旧快照覆盖」的竞态。
   */
  join(conn) {
    conn.joined = false;
    conn.pending = [];
    this.members.set(conn.id, conn);

    conn.send({
      type: MSG.WELCOME,
      roomId: this.id,
      bootEpoch: this.bootEpoch,
      serverSeq: this.serverSeq,
      shapes: [...this.shapes.values()],
      members: this.memberList(),
    });

    conn.joined = true;
    const buffered = conn.pending || [];
    conn.pending = null;
    for (const frame of buffered) conn.send(frame);
    if (buffered.length > 0) {
      this.log('info', `房间 ${this.id} 补发 ${buffered.length} 帧给 ${conn.clientId}`);
    }

    this.presence.set(conn.clientId, {
      clientId: conn.clientId,
      name: conn.name,
      color: conn.color,
      cursor: null,
    });
    this.broadcast(
      { type: MSG.PRESENCE, event: 'join', clientId: conn.clientId, name: conn.name, color: conn.color, cursor: null },
      conn.id,
    );
  }

  leave(conn) {
    this.members.delete(conn.id);
    // 同一 clientId 可能还有别的连接（重连竞争），最后一个走才广播离开
    const stillHere = [...this.members.values()].some((c) => c.clientId === conn.clientId);
    if (stillHere) return;
    this.presence.delete(conn.clientId);
    this.broadcast({ type: MSG.PRESENCE, event: 'leave', clientId: conn.clientId });
  }

  broadcast(msg, exceptConnId) {
    for (const conn of this.members.values()) {
      if (conn.id === exceptConnId) continue;
      if (conn.joined) {
        conn.send(msg);
      } else if (conn.pending) {
        if (conn.pending.length >= this.config.pendingFrameLimit) {
          conn.close(1008, 'pending overflow');
          continue;
        }
        conn.pending.push(msg);
      }
    }
  }

  updatePresence(conn, cursor) {
    if (!this.members.has(conn.id)) return;
    let safe = null;
    if (cursor && typeof cursor === 'object') {
      const { x, y } = cursor;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        safe = {
          x: Math.max(-MAX_CURSOR, Math.min(MAX_CURSOR, Math.round(x))),
          y: Math.max(-MAX_CURSOR, Math.min(MAX_CURSOR, Math.round(y))),
        };
      }
    }
    const entry = this.presence.get(conn.clientId) || {
      clientId: conn.clientId,
      name: conn.name,
      color: conn.color,
      cursor: null,
    };
    entry.cursor = safe;
    this.presence.set(conn.clientId, entry);
    this.broadcast(
      { type: MSG.PRESENCE, event: 'move', clientId: conn.clientId, name: conn.name, color: conn.color, cursor: safe },
      conn.id,
    );
  }

  // ── op 处理 ──────────────────────────────────────────────────

  /**
   * @returns {{ok:true, accepted:boolean, duplicate:boolean, shape:object|null, seq:number|null}
   *          | {ok:false, code:string, message:string, resync?:boolean}}
   */
  applyOp(conn, rawOp) {
    // 1) 校验 + 归一化（与客户端共用同一份实现）
    const parsed = normalizeOp(rawOp);
    if (!parsed.ok) {
      this.stats.rejected += 1;
      return { ok: false, code: parsed.code, message: parsed.message };
    }
    const op = parsed.op;

    // 2) 身份与房间绑定：不接受「替别人发」或「往别的房间发」的 op
    if (op.roomId !== this.id) {
      this.stats.rejected += 1;
      return { ok: false, code: 'ROOM_MISMATCH', message: 'op.roomId 与当前房间不一致' };
    }
    if (op.clientId !== conn.clientId) {
      this.stats.rejected += 1;
      return { ok: false, code: 'CLIENT_MISMATCH', message: 'op.clientId 与连接身份不一致' };
    }

    // 3) 幂等：opId 见过就复用上次结果
    const fingerprint = opFingerprint(op);
    const seenFp = this.seen.get(op.opId);
    if (seenFp !== undefined) {
      this.stats.duplicates += 1;
      if (seenFp !== fingerprint) {
        // 同 opId 不同内容：说明客户端有 bug 或有人在伪造，拒绝并要求重连对齐
        this.stats.rejected += 1;
        return { ok: false, code: 'OPID_CONFLICT', message: '同一 opId 携带了不同内容', resync: true };
      }
      return {
        ok: true,
        accepted: true,
        duplicate: true,
        shape: this.shapes.get(op.target) || null,
        seq: null,
      };
    }

    // 4) clientSeq 高水位：本地队列被清空后重发低序号，说明客户端状态不可信
    const hwmKey = `${op.clientId}:${op.sessionEpoch}`;
    const hwm = this.hwm.get(hwmKey) || 0;
    if (op.clientSeq <= hwm) {
      this.stats.resyncs += 1;
      return {
        ok: false,
        code: 'SEQ_RESET',
        message: `clientSeq ${op.clientSeq} 不大于高水位 ${hwm}`,
        resync: true,
      };
    }

    const current = this.shapes.get(op.target) || null;

    // 5) 未知图形：patch/delete 一个服务端没有的图形，说明客户端与服务端已分叉
    if (!current && op.kind !== OP_KIND.CREATE) {
      this.stats.resyncs += 1;
      return { ok: false, code: 'UNKNOWN_SHAPE', message: '目标图形不存在', resync: true };
    }
    if (current && op.kind === OP_KIND.CREATE && current.type !== op.shapeType) {
      this.stats.rejected += 1;
      return { ok: false, code: 'TYPE_CONFLICT', message: '同一 id 的图形类型不可变更' };
    }
    if (!current) {
      let alive = 0;
      for (const s of this.shapes.values()) if (isVisible(s)) alive += 1;
      if (alive >= LIMITS.MAX_SHAPES_PER_ROOM) {
        this.stats.rejected += 1;
        return { ok: false, code: 'ROOM_FULL', message: `房间图形数达到上限 ${LIMITS.MAX_SHAPES_PER_ROOM}` };
      }
    }

    // 6) 逐字段合并（陈旧 op 在这里被自然丢弃，不需要特判）
    const next = mergeOp(current, op);
    const changed = !shapesEqual(current, next);

    this.seen.set(op.opId, fingerprint);
    this.hwm.set(hwmKey, op.clientSeq);
    if (this.seen.size > this.config.seenOpLimit) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }

    if (!changed) {
      // 没产生状态变更（例如离线 op 版本落后于在线编辑）：回权威态让客户端自我修正
      this.stats.duplicates += 1;
      return { ok: true, accepted: false, duplicate: false, shape: current, seq: null };
    }

    // 7) 先落盘，再广播
    const seq = this.serverSeq + 1;
    this.store.append(this.id, { seq, shape: next });
    this.serverSeq = seq;
    this.shapes.set(op.target, next);
    this.stats.accepted += 1;

    if (this.store.lineCount(this.id) >= this.config.compactAfterLines) {
      this.store.compact(this.id, [...this.shapes.values()], this.serverSeq);
      this.stats.compactions += 1;
    }

    // 广播给所有人（含发起者）：发起者靠这条广播推进 lastAppliedSeq，
    // ack 只负责把 op 从待发队列里摘掉。
    this.broadcast({ type: MSG.OP, seq, bootEpoch: this.bootEpoch, shape: next, opId: op.opId });

    return { ok: true, accepted: true, duplicate: false, shape: next, seq };
  }

  snapshot() {
    return {
      shapes: [...this.shapes.values()],
      serverSeq: this.serverSeq,
      members: this.memberList(),
    };
  }

  statsView() {
    return {
      roomId: this.id,
      shapes: this.shapes.size,
      alive: [...this.shapes.values()].filter(isVisible).length,
      members: this.members.size,
      serverSeq: this.serverSeq,
      ...this.stats,
    };
  }
}

export { presenceColor, sanitizeName };
