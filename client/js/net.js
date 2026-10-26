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

  _onAck(msg) {
    this.store.dequeue(msg.opId);

    if (!msg.accepted) {
      // 离线期间被在线端超越：服务端带回权威态，本地强制覆盖
      if (msg.shape) this.store.adoptAuthoritative(msg.shape);
      this._log('warn', '离线修改版本落后，已采用服务端状态');
      this.handlers.onConflict?.(msg);
      this.handlers.onChange?.();
      return;
    }
    this.handlers.onChange?.();
  }

  _forceResync(reason) {
    this._log('warn', `触发全量重新同步（${reason}）`);
    this.lastApplied = 0;
    this._manualClose = true;
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

  _flushQueue() {
    const pending = this.store.takePending();
    if (!pending.length) return;
    this._log('info', `重放 ${pending.length} 条离线操作`);
    for (const op of pending) this._send({ type: MSG.OP, op });
    this.handlers.onStats?.();
  }

  // ── 发送 ─────────────────────────────────────────────────

  /** 本地新产生的 op：在线就直接发，离线就留在队列里 */
  sendOp(op) {
    if (this.state === 'online') {
      this._send({ type: MSG.OP, op });
    }
    this.handlers.onStats?.();
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
