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
import { isVisible, maxVersion, mergeOp, opFingerprint, shapesEqual } from '../shared/merge.js';

const MAX_CURSOR = 1e6;
/** 回收墓碑 id 的记忆上限：只用来挡住旧 create 重放，不值得无限增长 */
const PRUNED_LIMIT = 2_000;

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
    /**
     * 已被配额回收的墓碑 id（有界）。
     * 回收墓碑是为了不让「创建后删除」无限占内存，但墓碑一旦消失，
     * 一条极旧的 create 重放就能把图形「复活」。这里记下最近回收的 id，
     * 命中就拒绝并要求 resync —— 客户端会拿到不含该图形的权威快照。
     */
    this.pruned = new Set();
    /** connId → conn */
    this.members = new Map();
    /** clientId → { clientId, name, color, cursor } */
    this.presence = new Map();
    /**
     * clientId → { connId, msg }：本合并窗口内该客户端「最新」的那条 move 帧。
     * 按 clientId 做 key 而不是按 connId，是为了让同一客户端的多次移动天然去重；
     * 帧里仍记着来源 connId，断线时才能精确地把它丢掉（见 leave）。
     */
    this.pendingPresence = new Map();
    /** @type {NodeJS.Timeout|null} 合并窗口定时器；null 表示当前没有待 flush 的窗口 */
    this.presenceFlushTimer = null;

    this.stats = { accepted: 0, duplicates: 0, rejected: 0, resyncs: 0, compactions: 0 };

    /** 最后一次「有人进来 / 有人操作」的时间，空闲回收据此判断 */
    this.lastActive = Date.now();
  }

  /** 摸一下活跃时间：任何成员动作都算房间还活着 */
  touch() {
    this.lastActive = Date.now();
  }

  /** 是否可以被安全卸载：没有连接，且空闲超过 ttl */
  isIdle(now, ttlMs) {
    return this.members.size === 0 && now - this.lastActive >= ttlMs;
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
    this.touch();

    // presence 必须在发 WELCOME 之前写入：memberList() 读的就是这张表，
    // 晚一步的话「刚进来的人」自己不在成员列表里，单人在线时会显示成 0 人。
    this.presence.set(conn.clientId, {
      clientId: conn.clientId,
      name: conn.name,
      color: conn.color,
      cursor: null,
    });

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

    this.broadcast(
      { type: MSG.PRESENCE, event: 'join', clientId: conn.clientId, name: conn.name, color: conn.color, cursor: null },
      conn.id,
    );
  }

  leave(conn) {
    this.members.delete(conn.id);
    // 离开也算一次活跃：刚走的人可能马上回来，别让回收器卡在这个时刻立刻卸载
    this.touch();

    // 窗口里还压着这个连接的待发光标：人已经走了，补发只会让别人画布上留下
    // 一个永远不会消失的幽灵光标，直接丢弃。
    for (const [clientId, item] of this.pendingPresence) {
      if (item.connId === conn.id) this.pendingPresence.delete(clientId);
    }
    // 最后一个人离开时定时器必须清掉：空房间会被回收，一个还挂着的 timer
    // 会让这个 Room 既回收不干净、又把进程吊住。
    if (this.members.size === 0) this.clearPresenceWindow();

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

  /**
   * 合并窗口：鼠标移动这类高频帧只保留每个客户端的最新值，窗口结束时统一 flush。
   *
   * 为什么按房间而不是按连接合并：一次 flush 就是一趟「遍历成员 + 发帧」，
   * 10 个人同时移动时，逐帧广播是 N×N 次发送，合并后每个窗口只有 N 次。
   * 代价是最多一个窗口（50ms）的光标延迟，对远端光标完全可接受。
   */
  updatePresence(conn, cursor) {
    if (!this.members.has(conn.id)) return;
    this.touch();
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

    // 后到的覆盖先到的：窗口里只有「最新位置」有意义，中间那些帧谁都不需要。
    this.pendingPresence.set(conn.clientId, {
      connId: conn.id,
      msg: { type: MSG.PRESENCE, event: 'move', clientId: conn.clientId, name: conn.name, color: conn.color, cursor: safe },
    });

    if (!this.presenceFlushTimer) {
      const timer = setTimeout(() => {
        this.presenceFlushTimer = null;
        this.flushPresence();
      }, this.config.presenceFlushMs);
      // 别让一个待发的光标窗口把进程吊住（测试进程 / 优雅退出都会被它拖住）
      timer.unref?.();
      this.presenceFlushTimer = timer;
    }
  }

  /** 清掉合并窗口：定时器与待发帧一起丢，房间空了或即将卸载时用 */
  clearPresenceWindow() {
    if (this.presenceFlushTimer) {
      clearTimeout(this.presenceFlushTimer);
      this.presenceFlushTimer = null;
    }
    this.pendingPresence.clear();
  }

  /** 把窗口内每个客户端的最新光标各广播一次 */
  flushPresence() {
    if (this.pendingPresence.size === 0) return;
    const batch = this.pendingPresence;
    this.pendingPresence = new Map();

    for (const [clientId, item] of batch) {
      // 二次校验：窗口排队期间人可能已经断线或换了新连接，
      // 这时旧帧发出去就是一个再也不会被清除的光标。
      const conn = this.members.get(item.connId);
      if (!conn || conn.clientId !== clientId) continue;
      this.broadcast(item.msg, item.connId);
    }
  }

  // ── op 处理 ──────────────────────────────────────────────────

  /**
   * 记录 clientSeq 高水位，并维持 LRU 上限。
   *
   * 为什么淘汰是安全的：真正的幂等由 seen（opId → 指纹）保证——同一个 op 重发
   * 必然被 seen 拦下，根本不看 hwm。hwm 只是「廉价地」拒绝同一会话里明显倒退的
   * clientSeq（客户端本地待发队列被清空过）。淘汰一条后，该会话若再发来旧
   * clientSeq，最坏情况只是它被当成正常 op 走完整流程：
   *   · opId 是旧的 → seen 命中，回放上次结果，不会重复应用；
   *   · opId 是新的但内容陈旧 → merge.js 的逐字段 ver 比较会把它丢掉，状态不回退。
   * 也就是说 hwm 丢一条只会少一次「快速拒绝」，绝不会多一次「错误应用」。
   */
  rememberHwm(key, seq) {
    this.hwm.delete(key);
    this.hwm.set(key, seq);
    while (this.hwm.size > this.config.hwmLimit) {
      const oldest = this.hwm.keys().next().value;
      this.hwm.delete(oldest);
    }
  }

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
    const known = this.hwm.get(hwmKey);
    if (known !== undefined) {
      // 命中即算「用过」：LRU 的淘汰顺序要跟着真实使用走，而不是只看写入，
      // 否则一个只在重连后才发 op 的客户端会被误判成最久未使用。
      this.hwm.delete(hwmKey);
      this.hwm.set(hwmKey, known);
    }
    const hwm = known || 0;
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
    // 5.5) 版本上界：ver 必须落在「当前最大版本 + 1」以内。
    //      只校验 1..1e9 是不够的——一条 ver=1e9 的畸形 op 会让图形永久冻结：
    //      之后所有正常客户端算出的 ver 都是 1e9+1，全部被 BAD_VERSION 拒绝，
    //      连删除都发不出去。下界不校验，因为落后的离线 op 本来就该被合并逻辑丢弃。
    const maxVer = maxVersion(current);
    if (op.ver > maxVer + 1) {
      this.stats.rejected += 1;
      return {
        ok: false,
        code: 'VER_TOO_FAR',
        message: `ver ${op.ver} 超过当前最大版本 ${maxVer} + 1`,
      };
    }

    if (!current) {
      // 墓碑被配额回收后，旧 create 重放不能把它复活
      if (op.kind === OP_KIND.CREATE && this.pruned.has(op.target)) {
        this.stats.resyncs += 1;
        return { ok: false, code: 'SHAPE_PRUNED', message: '图形已被删除', resync: true };
      }
      // 配额按 shapes.size 计：墓碑同样占内存、同样会写进快照，
      // 只数 isVisible 的话「创建后立刻删除」可以无限绕过上限。
      if (this.shapes.size >= LIMITS.MAX_SHAPES_PER_ROOM) this.pruneTombstones();
      if (this.shapes.size >= LIMITS.MAX_SHAPES_PER_ROOM) {
        this.stats.rejected += 1;
        return { ok: false, code: 'ROOM_FULL', message: `房间图形数达到上限 ${LIMITS.MAX_SHAPES_PER_ROOM}` };
      }
    }

    // 6) 逐字段合并（陈旧 op 在这里被自然丢弃，不需要特判）
    const next = mergeOp(current, op);
    const changed = !shapesEqual(current, next);

    this.seen.set(op.opId, fingerprint);
    this.rememberHwm(hwmKey, op.clientSeq);
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

  /**
   * 房间满时回收最老的墓碑，腾出配额。
   *
   * 丢墓碑不会让已删除的图形「复活」：离线端带着旧副本回来时，
   * 对未知图形的 patch 会被 UNKNOWN_SHAPE 拒绝并要求 resync，
   * 客户端拿到的权威快照里本来就没有这个图形。
   * 因此这里按插入顺序（Map 天然保序）丢掉最老的一批墓碑是安全的。
   */
  pruneTombstones() {
    if (this.shapes.size < LIMITS.MAX_SHAPES_PER_ROOM) return 0;
    const target = Math.floor(LIMITS.MAX_SHAPES_PER_ROOM * 0.9);
    let removed = 0;
    for (const [id, shape] of this.shapes) {
      if (this.shapes.size <= target) break;
      if (isVisible(shape)) continue;
      this.shapes.delete(id);
      this.pruned.add(id);
      while (this.pruned.size > PRUNED_LIMIT) {
        this.pruned.delete(this.pruned.values().next().value);
      }
      removed += 1;
    }
    return removed;
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
      idleMs: Date.now() - this.lastActive,
      ...this.stats,
    };
  }
}

export { presenceColor, sanitizeName };
