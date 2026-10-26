/**
 * 多人光标（awareness）。
 * 光标位置不进入文档状态、不落盘，纯瞬时信息 —— 掉线丢失也无所谓，
 * 因此和 op 走两条独立通道，避免污染一致性模型。
 */

const CURSOR_THROTTLE = 80;

const ARROW_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M5 3l13.5 7.6-6 1.6-2.4 6L5 3z" fill="currentColor" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`;

export class Presence {
  constructor({ layer, board, onSend }) {
    this.layer = layer;
    this.board = board;
    this.onSend = onSend;
    this.peers = new Map();
    this._lastSent = 0;
    this._pending = null;
    this._timer = null;
  }

  /** 从 welcome 的成员列表初始化 */
  setMembers(list) {
    const alive = new Set();
    for (const m of list) {
      alive.add(m.clientId);
      if (!this.peers.has(m.clientId)) this._ensurePeer(m);
    }
    for (const id of [...this.peers.keys()]) {
      if (!alive.has(id)) this._remove(id);
    }
    this.render();
  }

  handle(msg) {
    if (msg.event === 'leave') {
      this._remove(msg.clientId);
      return;
    }
    const peer = this._ensurePeer({ clientId: msg.clientId, name: msg.name, color: msg.color });
    if (!peer) return;
    if (msg.name) peer.name = msg.name;
    if (msg.color) peer.color = msg.color;
    peer.cursor = msg.cursor || null;
    this.render();
  }

  _ensurePeer({ clientId, name, color }) {
    if (!clientId) return null;
    let peer = this.peers.get(clientId);
    if (peer) return peer;

    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.innerHTML = ARROW_SVG;
    const label = document.createElement('span');
    label.textContent = name || '访客';
    label.style.background = color || '#64748b';
    el.querySelector('svg').style.color = color || '#64748b';
    el.appendChild(label);
    el.style.display = 'none';
    this.layer.appendChild(el);

    peer = { clientId, name, color, cursor: null, el, label };
    this.peers.set(clientId, peer);
    return peer;
  }

  _remove(clientId) {
    const peer = this.peers.get(clientId);
    if (!peer) return;
    peer.el.remove();
    this.peers.delete(clientId);
  }

  /** 视口变化或收到光标更新后重排 */
  render() {
    for (const peer of this.peers.values()) {
      if (!peer.cursor) {
        peer.el.style.display = 'none';
        continue;
      }
      const p = this.board.worldToScreen(peer.cursor);
      peer.el.style.display = 'block';
      peer.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      peer.label.textContent = peer.name || '访客';
    }
  }

  /** 本地光标：节流后上报（100ms 一次足够，别把带宽浪费在鼠标上） */
  sendLocal(worldPt) {
    this._pending = worldPt;
    const now = performance.now();
    const elapsed = now - this._lastSent;
    if (elapsed >= CURSOR_THROTTLE) {
      this._flush();
      return;
    }
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, CURSOR_THROTTLE - elapsed);
  }

  _flush() {
    this._lastSent = performance.now();
    this.onSend?.(this._pending);
  }

  clearAll() {
    for (const id of [...this.peers.keys()]) this._remove(id);
  }
}
