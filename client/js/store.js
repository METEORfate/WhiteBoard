/**
 * 客户端文档状态。
 *
 * 职责：
 *   1. 持有本地文档副本（Map<shapeId, shape>），所有编辑先本地生效（乐观应用），
 *      界面永远不等网络；
 *   2. 维护待发队列（localStorage 持久化），断网时继续累积，重连后按序重放；
 *   3. 维护撤销/重做栈——撤销不删除历史，而是生成一条新的反向 op，
 *      因此撤销本身也是可同步、可收敛的。
 *
 * 所有 op 的 ver 在「入队那一刻」就冻结，重试不会重算。
 * 一旦重算，两端对同一个逻辑操作会得到不同的戳，最终状态就会分叉。
 */

import { OP_KIND, normalizeShape } from '../../shared/protocol.js';
import { flatten, isVisible, maxVersion, mergeOp, mergeShape, shapesEqual } from '../../shared/merge.js';
import { uuid } from '../../shared/ids.js';

const DOC_KEY = (room) => `wb:doc:${room}`;
const QUEUE_KEY = (room) => `wb:queue:${room}`;
const SEQ_KEY = (room) => `wb:seq:${room}`;

const UNDO_LIMIT = 120;
const DOC_SAVE_DEBOUNCE = 120;

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('本地存储写入失败', err);
  }
}

export class DocStore {
  constructor({ roomId, clientId, sessionEpoch, clientSeq = 0, onChange, onOp, onLog }) {
    this.roomId = roomId;
    this.clientId = clientId;
    this.sessionEpoch = sessionEpoch;
    this.clientSeq = clientSeq;

    /** @type {Map<string, object>} */
    this.shapes = new Map();
    /** @type {object[]} 待发送 op，按 clientSeq 升序 */
    this.pending = [];
    this.undoStack = [];
    this.redoStack = [];

    this.onChange = onChange || (() => {});
    this.onOp = onOp || (() => {});
    this.onLog = onLog || (() => {});

    this._docTimer = null;
    this._restore();
  }

  // ── 持久化 ────────────────────────────────────────────────

  _restore() {
    const cached = readJSON(DOC_KEY(this.roomId), []);
    for (const raw of cached) {
      const r = normalizeShape(raw);
      if (r.ok) this.shapes.set(r.shape.id, r.shape);
    }

    const queue = readJSON(QUEUE_KEY(this.roomId), []);
    this.pending = Array.isArray(queue) ? queue.filter((op) => op && op.opId) : [];

    const savedSeq = Number(localStorage.getItem(SEQ_KEY(this.roomId)) || 0);
    const maxQueued = this.pending.reduce((m, op) => Math.max(m, op.clientSeq || 0), 0);
    this.clientSeq = Math.max(this.clientSeq, savedSeq, maxQueued);

    if (this.shapes.size || this.pending.length) {
      this.onLog('info', `本地缓存恢复：${this.shapes.size} 图形 / ${this.pending.length} 条待同步`);
    }
  }

  _persistDoc() {
    if (this._docTimer) return;
    this._docTimer = setTimeout(() => {
      this._docTimer = null;
      this._writeDoc();
    }, DOC_SAVE_DEBOUNCE);
  }

  _writeDoc() {
    writeJSON(DOC_KEY(this.roomId), [...this.shapes.values()]);
  }

  /** 立即落盘（页面关闭前调用，避免防抖窗口内的编辑丢失） */
  flush() {
    if (this._docTimer) {
      clearTimeout(this._docTimer);
      this._docTimer = null;
    }
    this._writeDoc();
    this._persistQueue();
  }

  _persistQueue() {
    writeJSON(QUEUE_KEY(this.roomId), this.pending);
  }

  _persistSeq() {
    try {
      localStorage.setItem(SEQ_KEY(this.roomId), String(this.clientSeq));
    } catch {
      /* ignore */
    }
  }

  // ── 读取 ──────────────────────────────────────────────────

  /** 可见图形，按 z 升序（z 相同按 id，保证各端绘制顺序一致） */
  list() {
    return [...this.shapes.values()]
      .filter(isVisible)
      .sort((a, b) => {
        const za = flatten(a).z;
        const zb = flatten(b).z;
        if (za !== zb) return za - zb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }

  getShape(id) {
    return this.shapes.get(id) || null;
  }

  flat(id) {
    const shape = this.shapes.get(id);
    return shape ? flatten(shape) : null;
  }

  stats() {
    let visible = 0;
    for (const s of this.shapes.values()) if (isVisible(s)) visible += 1;
    return { total: this.shapes.size, visible, pending: this.pending.length };
  }

  // ── op 构造 ───────────────────────────────────────────────

  _nextOp({ kind, target, patch, ver, shapeType }) {
    this.clientSeq += 1;
    this._persistSeq();
    const op = {
      opId: uuid(),
      roomId: this.roomId,
      clientId: this.clientId,
      sessionEpoch: this.sessionEpoch,
      clientSeq: this.clientSeq,
      kind,
      target,
      ver,
      patch,
      ts: Date.now(),
    };
    if (kind === OP_KIND.CREATE) op.shapeType = shapeType;
    return op;
  }

  _enqueue(op) {
    this.pending.push(op);
    this._persistQueue();
    this.onOp(op);
  }

  _versionOf(id) {
    const shape = this.shapes.get(id);
    return maxVersion(shape) + 1;
  }

  // ── 本地编辑（乐观应用）────────────────────────────────────

  /**
   * 创建图形。style 中的字段会写进 create 的 patch，
   * 这样「新建即带样式」也是一次原子操作。
   */
  createShape({ type, x, y, w, h, ...style }) {
    const id = uuid();
    const patch = {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.max(2, Math.round(w)),
      h: Math.max(2, Math.round(h)),
      z: Date.now(),
      deleted: false,
      ...style,
    };
    const op = this._nextOp({ kind: OP_KIND.CREATE, target: id, patch, ver: 1, shapeType: type });
    this.shapes.set(id, mergeOp(null, op));
    this._pushUndo(`创建${typeLabel(type)}`, [
      {
        id,
        forward: { kind: OP_KIND.PATCH, patch: { ...patch } },
        backward: { kind: OP_KIND.DELETE, patch: { deleted: true } },
      },
    ]);
    this._enqueue(op);
    this.onChange();
    this._persistDoc();
    return { id, op };
  }

  /** 修改图形字段（移动、缩放、改样式、改文本都走这里） */
  applyLocal(id, patch, { record = true, label = '修改' } = {}) {
    const shape = this.shapes.get(id);
    if (!shape) return null;

    const before = flatten(shape);
    const prevPatch = {};
    for (const key of Object.keys(patch)) prevPatch[key] = before[key];

    const op = this._nextOp({ kind: OP_KIND.PATCH, target: id, patch, ver: this._versionOf(id) });
    this.shapes.set(id, mergeOp(shape, op));

    if (record) {
      this._pushUndo(label, [
        {
          id,
          forward: { kind: OP_KIND.PATCH, patch: { ...patch } },
          backward: { kind: OP_KIND.PATCH, patch: prevPatch },
        },
      ]);
    }

    this._enqueue(op);
    this.onChange();
    this._persistDoc();
    return op;
  }

  /** 删除 = 打墓碑，不做物理删除，否则离线端会把它「复活」 */
  deleteShape(id, { record = true } = {}) {
    const shape = this.shapes.get(id);
    if (!shape || !isVisible(shape)) return null;

    const op = this._nextOp({
      kind: OP_KIND.DELETE,
      target: id,
      patch: { deleted: true },
      ver: this._versionOf(id),
    });
    this.shapes.set(id, mergeOp(shape, op));

    if (record) {
      this._pushUndo('删除', [
        {
          id,
          forward: { kind: OP_KIND.DELETE, patch: { deleted: true } },
          backward: { kind: OP_KIND.PATCH, patch: { deleted: false } },
        },
      ]);
    }

    this._enqueue(op);
    this.onChange();
    this._persistDoc();
    return op;
  }

  /** 拖动结束时登记一条合并后的撤销记录（拖动过程中的中间 op 不单独记录） */
  recordUndo({ label, items }) {
    if (!items || !items.length) return;
    this._pushUndo(label, items);
  }

  _pushUndo(label, items) {
    this.undoStack.push({ label, items });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  // ── 撤销 / 重做 ───────────────────────────────────────────

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this._applyEntry(entry, 'backward');
    this.redoStack.push(entry);
    this.onChange();
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this._applyEntry(entry, 'forward');
    this.undoStack.push(entry);
    this.onChange();
    return true;
  }

  /**
   * 撤销/重做不重放旧 op，而是用「当前版本 +1」重新生成一条新 op。
   * 否则旧 op 的版本号已经落后，服务端会直接拒掉，用户点了撤销却毫无反应。
   */
  _applyEntry(entry, direction) {
    for (const item of entry.items) {
      const shape = this.shapes.get(item.id);
      if (!shape) continue;

      const spec = item[direction];
      if (!spec) continue;
      const kind = spec.kind === OP_KIND.DELETE ? OP_KIND.DELETE : OP_KIND.PATCH;
      const op = this._nextOp({
        kind,
        target: item.id,
        patch: { ...spec.patch },
        ver: this._versionOf(item.id),
      });
      this.shapes.set(item.id, mergeOp(shape, op));
      this._enqueue(op);
    }
    this._persistDoc();
  }

  // ── 远端应用 ─────────────────────────────────────────────

  /** 应用服务端广播的权威图形（同戳时采用服务端值，吸收归一化） */
  applyRemote(rawShape) {
    const r = normalizeShape(rawShape);
    if (!r.ok) {
      this.onLog('err', `丢弃非法图形：${r.message}`);
      return false;
    }
    const incoming = r.shape;
    const current = this.shapes.get(incoming.id);
    // 注意：这里必须用 mergeShape（图形 vs 图形），不能用 mergeOp（图形 vs op）
    this.shapes.set(
      incoming.id,
      current ? mergeShape(current, incoming, { authoritative: true }) : incoming,
    );
    this._persistDoc();
    return true;
  }

  /** 重连后把本地未同步的 op 重新叠回快照之上（幂等，不会产生重复图形） */
  replayPendingLocally() {
    for (const op of this.pending) {
      const current = this.shapes.get(op.target);
      if (!current && op.kind !== OP_KIND.CREATE) continue;
      this.shapes.set(op.target, mergeOp(current, op));
    }
  }

  /** 用服务端快照整体替换本地文档，再叠回待发队列 */
  replaceAll(rawShapes) {
    const next = new Map();
    let rejected = 0;
    for (const raw of rawShapes) {
      const r = normalizeShape(raw);
      if (r.ok) next.set(r.shape.id, r.shape);
      else rejected += 1;
    }
    this.shapes = next;
    this.replayPendingLocally();
    if (rejected > 0) this.onLog('warn', `快照中有 ${rejected} 个非法图形被丢弃`);
    this.onChange();
    this._persistDoc();
  }

  /** 采用服务端权威态覆盖单个图形（离线 op 被判定落后时使用） */
  adoptAuthoritative(rawShape) {
    const r = normalizeShape(rawShape);
    if (!r.ok) return false;
    this.shapes.set(r.shape.id, r.shape);
    this.onChange();
    this._persistDoc();
    return true;
  }

  // ── 队列 ─────────────────────────────────────────────────

  takePending() {
    return [...this.pending].sort((a, b) => a.clientSeq - b.clientSeq);
  }

  dequeue(opId) {
    const before = this.pending.length;
    if (!before) return;
    this.pending = this.pending.filter((op) => op.opId !== opId);
    if (this.pending.length !== before) this._persistQueue();
  }

  clearQueue() {
    this.pending = [];
    this._persistQueue();
  }

  /** 一致性自检：本地文档与服务端快照是否等价（调试面板用） */
  digest() {
    const ids = [...this.shapes.keys()].sort();
    return ids.map((id) => {
      const s = this.shapes.get(id);
      const flat = flatten(s);
      return `${id.slice(0, 4)}:${flat.x},${flat.y},${flat.w},${flat.h},${flat.deleted ? 'D' : 'A'}`;
    });
  }

  hasShape(id) {
    return this.shapes.has(id);
  }

  /** 供测试/调试：判断某图形与服务端副本是否一致 */
  matches(shape) {
    const local = this.shapes.get(shape.id);
    return Boolean(local) && shapesEqual(local, shape);
  }
}

function typeLabel(type) {
  if (type === 'rect') return '矩形';
  if (type === 'ellipse') return '椭圆';
  if (type === 'text') return '文本';
  return '图形';
}
