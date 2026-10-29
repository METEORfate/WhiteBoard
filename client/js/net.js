/**
 * 网络层：WebSocket 连接、握手、心跳、断线重连与离线队列重放。
 *
 * 状态机：
 *   idle → connecting → syncing → online ⇄ offline
 *   syncing 期间不发 op（本地编辑照常进队列），收到 welcome 后一次性重放。
 *
 * 两条不能破的规则：
 *   1. lastAppliedSeq 只由「快照」和「广播 op」推进，绝不由 ack 推进。
 *      否则 ack(seq=10) 会把还在途的 seq=9 当成重放丢掉。
 *   2. seq 出现缺口（不等于 lastApplied+1）时必须全量重拉，不能继续增量应用。
 */

import { MSG } from '../../shared/protocol.js';

const HEARTBEAT_MS = 15_000;
const STALE_MS = 32_000;
const TICK_MS = 5_000;
const BASE_DELAY = 500;
const MAX_DELAY = 15_000;
/**
 * 重放节奏。服务端令牌桶是 60 条/秒、突发 120，这里取 30 条/秒：
 * 给光标上报（10 条/秒）和心跳留出余量，宁可慢一点也不要被限流打断。
 */
const SEND_RATE = 30;
/** 在途 op 上限：再配合令牌桶，重放既不会打空服务端的桶，也不会无限积压 */
const FLUSH_WINDOW = 32;
/**
 * 单条 op 的 ack 超时。超过这个时间还没等到 ack，就从在途窗口里摘掉重发。
 * 没有这条兜底时，一条丢失的 ack 会永久占住窗口；占满 32 个之后
 * 整个发送循环停摆，而界面还显示「已连接」，用户只能刷新页面。
 */
const ACK_TIMEOUT = 5_000;

export class Net {
  constructor({ roomId, identity, store, handlers = {} }) {
    this.roomId = roomId;
    this.identity = identity;
    this.store = store;
    this.handlers = handlers;

    this.ws = null;
    this.state = 'idle';
    this.lastApplied = 0;
    this.bootEpoch = null;
    this.retries = 0;
    this.sent = 0;
    this.recv = 0;
    this.lastMessageAt = 0;
    this.lastPingAt = 0;
    this.simulatedOffline = false;

    this._reconnectTimer = null;
    this._tickTimer = null;
    this._manualClose = false;
    /** 已发出、还没收到 ack 的 opId（滑动窗口用） */
    this._sent = new Set();
    /** opId → 发出时间，用于 ack 超时重发 */
    this._sentAt = new Map();
    /** 客户端侧的发送令牌桶，避免把服务端的桶一次打空 */
    this._tokens = SEND_RATE;
    this._refilledAt = Date.now();
    this._pumpTimer = null;
  }

  // ── 生命周期 ──────────────────────────────────────────────

  _url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect() {
    if (this.simulatedOffline) {
      this._setState('offline');
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this._clearReconnect();
    this._setState('connecting');

    let ws;
    try {
      ws = new WebSocket(this._url());
    } catch (err) {
      this._log('err', `无法建立连接：${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this._setState('syncing');
      this.lastMessageAt = Date.now();
      this._startTick();
      this._send({
        type: MSG.HELLO,
        roomId: this.roomId,
        clientId: this.identity.clientId,
        sessionEpoch: this.identity.sessionEpoch,
        name: this.identity.name,
        lastSeq: this.lastApplied,
      });
    };

    ws.onmessage = (ev) => {
      this.recv += 1;
      this.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        this._log('warn', '收到非 JSON 消息，已丢弃');
        return;
      }
      try {
        this._handle(msg);
      } catch (err) {
        this._log('err', `处理消息异常：${err.message}`);
      }
      this.handlers.onStats?.();
    };

    ws.onerror = () => {
      // 具体原因由 onclose 处理，这里只记一笔
      this._log('warn', 'WebSocket 出错');
    };

    ws.onclose = (ev) => {
      this._stopTick();
      clearTimeout(this._pumpTimer); // 断线时停掉重放节拍，重连后由 _flushQueue 重启
      this._pumpTimer = null;
      this.ws = null;
      const wasOnline = this.state === 'online' || this.state === 'syncing';
      this._setState('offline');
      if (wasOnline && ev.code !== 1000) {
        this._log('warn', `连接断开（${ev.code}），本地编辑继续，稍后自动重连`);
      }
      if (!this._manualClose && !this.simulatedOffline) this._scheduleReconnect();
      this._manualClose = false;
    };
  }

  disconnect() {
    this._manualClose = true;
    this._stopTick();
    this._clearReconnect();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client close');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this._setState('offline');
  }

  setSimulatedOffline(on) {
    this.simulatedOffline = on;
    if (on) {
      this._log('warn', '已开启断网模拟：本地编辑将进入待发队列');
      this._manualClose = true;
      this._stopTick();
      this._clearReconnect();
      if (this.ws) {
        try {
          this.ws.close(4001, 'simulated offline');
        } catch {
          /* ignore */
        }
        this.ws = null;
      }
      this._setState('offline');
    } else {
      this._log('info', '已恢复网络：开始重连并重放队列');
      this.retries = 0;
      this.connect();
    }
  }

  _scheduleReconnect() {
    this._clearReconnect();
    const delay = Math.min(MAX_DELAY, BASE_DELAY * 2 ** this.retries) + Math.random() * 300;
    this.retries += 1;
    this.handlers.onStats?.();
    this._log('info', `${Math.round(delay)}ms 后重连（第 ${this.retries} 次）`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** 用户手动恢复网络 / 浏览器 online 事件 → 立刻重试，不等退避 */
  retryNow() {
    if (this.simulatedOffline) return;
    if (this.state === 'online' || this.state === 'syncing' || this.state === 'connecting') return;
    this.retries = 0;
    this._clearReconnect();
    this.connect();
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _startTick() {
    this._stopTick();
    this._tickTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - this.lastMessageAt > STALE_MS) {
        this._log('warn', '心跳超时，主动断开以触发重连');
        try {
          this.ws.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        return;
      }
      if (now - this.lastPingAt > HEARTBEAT_MS) {
        this.lastPingAt = now;
        this._send({ type: MSG.PING, t: now });
      }
    }, TICK_MS);
  }

  _stopTick() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  // ── 消息处理 ──────────────────────────────────────────────

  _handle(msg) {
    switch (msg.type) {
      case MSG.WELCOME:
        return this._onWelcome(msg);
      case MSG.OP:
        return this._onOp(msg);
      case MSG.ACK:
        return this._onAck(msg);
      case MSG.PRESENCE:
        this.handlers.onPresence?.(msg);
        return undefined;
      case MSG.PONG:
        return undefined;
      case MSG.RESYNC:
        this._log('warn', `服务端要求重新同步：${msg.reason || 'unknown'}`);
        return this._forceResync(msg.reason);
      case MSG.ERROR:
        this._log('warn', `服务端拒绝：${msg.code} ${msg.message || ''}`);
        this._onRejected(msg);
        this.handlers.onServerError?.(msg);
        return undefined;
      default:
        this._log('warn', `未知消息类型 ${msg.type}`);
        return undefined;
    }
  }

  _onWelcome(msg) {
    const epochChanged = this.bootEpoch && msg.bootEpoch !== this.bootEpoch;
    this.bootEpoch = msg.bootEpoch;

    this.lastApplied = msg.serverSeq || 0;
    this.store.replaceAll(msg.shapes || []);
    this._setState('online');

    this.handlers.onMembers?.(msg.members || []);
    this._log(
      'ok',
      `已同步：${(msg.shapes || []).length} 个图形，serverSeq=${this.lastApplied}${epochChanged ? '（服务端已重启，全量重拉）' : ''}`,
    );

    this._flushQueue();
  }

  _onOp(msg) {
    if (msg.bootEpoch !== this.bootEpoch) {
      this._log('warn', '收到其他 bootEpoch 的广播，全量重拉');
      this._forceResync('bootEpoch-mismatch');
      return;
    }
    if (msg.seq <= this.lastApplied) return; // 重放或乱序的旧帧
    if (this.lastApplied > 0 && msg.seq !== this.lastApplied + 1) {
      this._log('warn', `serverSeq 出现缺口（期望 ${this.lastApplied + 1}，收到 ${msg.seq}），全量重拉`);
      this._forceResync('seq-gap');
      return;
    }

    this.store.applyRemote(msg.shape);
    this.store.dequeue(msg.opId);
    this.lastApplied = msg.seq;
    this.handlers.onChange?.();
  }

  /**
   * 服务端拒绝一条消息。
   * - 限流：清掉在途标记、桶清零、退避后重发（opId 幂等，重发是安全的）；
   * - 其余带 opId 的错误（坏数据 / 房间满 / 图形不存在）：这条 op 永远不会成功，
   *   直接从队列摘掉，否则它会一直卡在队首把整条队列堵死。
   */
  _onRejected(msg) {
    if (msg.code === 'RATE_LIMITED') {
      this._sent.clear();
      this._sentAt.clear();
      this._tokens = 0;
      this._schedulePump(500);
      return;
    }
    if (!msg.opId) return;
    this._sent.delete(msg.opId);
    this._sentAt.delete(msg.opId);
    this.store.dequeue(msg.opId);
    this._log('warn', `一条操作被服务端丢弃（${msg.code}）`);

    // 版本号超前说明本地与服务端已经对不上（正常客户端不会算错 ver）。
    // 只把 op 摘掉会让本地留着一条远端没有的修改，必须重新拉快照对齐。
    if (msg.code === 'VER_TOO_FAR') {
      this._forceResync('VER_TOO_FAR');
      return;
    }
    this._schedulePump(0);
  }

  _onAck(msg) {
    this._sent.delete(msg.opId);
    this._sentAt.delete(msg.opId);
    const op = this.store.pending.find((o) => o.opId === msg.opId) || null;
    this.store.dequeue(msg.opId);

    if (!msg.accepted) {
      let retried = false;
      if (msg.shape) {
        // 离线期间被在线端超越：先采用权威态，再把这条 op 重新盖上去。
        // 只覆盖不复用 —— 用户的改动不会因为本地版本号陈旧而凭空消失。
        this.store.adoptAuthoritative(msg.shape);
        retried = Boolean(this.store.rebase(op, msg.shape));
      }
      this._log(
        retried ? 'ok' : 'warn',
        retried ? '离线修改版本落后，已在最新状态上重新应用' : '离线修改版本落后，已采用服务端状态',
      );
      this.handlers.onConflict?.({ ...msg, retried });
    }

    this.handlers.onChange?.();
    this._pump(); // 窗口腾出一个位置，把队列里剩下的继续发
  }

  _forceResync(reason) {
    this._log('warn', `触发全量重新同步（${reason}）`);
    this.lastApplied = 0;
    this._manualClose = true;
    this._sent.clear();
    this._sentAt.clear();
    clearTimeout(this._pumpTimer);
    this._pumpTimer = null;
    if (this.ws) {
      try {
        this.ws.close(4002, 'resync');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this._stopTick();
    this.retries = 0;
    this._clearReconnect();
    setTimeout(() => {
      if (!this.simulatedOffline) this.connect();
    }, 60);
  }

  /** 重连后排空离线队列：交给 _pump 做滑动窗口，不要一次全发 */
  _flushQueue() {
    this._sent.clear();
    this._sentAt.clear();
    const queued = this.store.takePending().length;
    if (!queued) return;
    this._log('info', `重放 ${queued} 条离线操作（窗口 ${FLUSH_WINDOW} 条在途）`);
    this._pump();
  }

  /**
   * 按令牌桶节奏发送，同时限制 FLUSH_WINDOW 条在途。
   * 只限在途数量是不够的：本地 RTT 极小时窗口会被瞬间补满，
   * 实际速率仍然能到几千条/秒 —— 必须连速率一起限。
   */
  _pump() {
    if (this.state !== 'online' || this._pumpTimer) return;

    const now = Date.now();
    this._tokens = Math.min(SEND_RATE, this._tokens + ((now - this._refilledAt) / 1000) * SEND_RATE);
    this._refilledAt = now;

    // 在途超时：窗口只有 FLUSH_WINDOW 个位置，一条 ack 丢失就会永久占位。
    // 累计到上限后 _pump 会在循环首行直接 break，界面却仍显示「已连接」，
    // 之后所有编辑只进队列、永不发送。opId 幂等，重发是安全的。
    let timedOut = false;
    for (const opId of this._sent) {
      const sentAt = this._sentAt.get(opId);
      // 认不出发送时间的（例如测试里直接塞进 _sent）按「刚发出」处理，不误杀
      if (sentAt !== undefined && now - sentAt > ACK_TIMEOUT) {
        this._sent.delete(opId);
        this._sentAt.delete(opId);
        timedOut = true;
      }
    }
    if (timedOut) this._log('warn', `有操作超过 ${ACK_TIMEOUT / 1000}s 未确认，重新发送`);

    for (const op of this.store.takePending()) {
      if (this._sent.size >= FLUSH_WINDOW) break;
      if (this._sent.has(op.opId)) continue;
      if (this._tokens < 1) {
        this._schedulePump(50);
        break;
      }
      this._sent.add(op.opId);
      this._sentAt.set(op.opId, now);
      if (!this._send({ type: MSG.OP, op })) {
        this._sent.delete(op.opId);
        this._sentAt.delete(op.opId);
        break;
      }
      this._tokens -= 1;
    }
    // 窗口被占满时安排一次「超时巡检」，否则 ack 全丢的情况下没人再叫醒 _pump
    if (this._sent.size >= FLUSH_WINDOW) this._schedulePump(ACK_TIMEOUT);
    this.handlers.onStats?.();
  }

  _schedulePump(delay) {
    if (this._pumpTimer) return;
    this._pumpTimer = setTimeout(() => {
      this._pumpTimer = null;
      this._pump();
    }, delay);
  }

  // ── 发送 ─────────────────────────────────────────────────

  /** 本地新产生的 op：它已经在待发队列里，在线就交给窗口统一发送 */
  sendOp() {
    if (this.state === 'online') this._pump();
  }

  sendPresence(cursor) {
    if (this.state !== 'online') return;
    this._send({ type: MSG.PRESENCE, cursor });
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      this.sent += 1;
      return true;
    } catch (err) {
      this._log('err', `发送失败：${err.message}`);
      return false;
    }
  }

  // ── 状态与日志 ───────────────────────────────────────────

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState?.(state);
  }

  _log(level, message) {
    this.handlers.onLog?.(level, message);
  }

  stats() {
    return {
      state: this.state,
      lastApplied: this.lastApplied,
      bootEpoch: this.bootEpoch,
      retries: this.retries,
      sent: this.sent,
      recv: this.recv,
    };
  }
}
