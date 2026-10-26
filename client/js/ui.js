/**
 * UI 装配层：工具栏、样式面板、状态条、调试面板、Toast。
 * 只做 DOM 与事件绑定，所有状态变更都转发给 store / interactions / net。
 */

const STATE_LABEL = {
  idle: '未连接',
  connecting: '连接中…',
  syncing: '同步中…',
  online: '已连接',
  offline: '离线（本地可编辑）',
};

const LOG_LIMIT = 40;

export class UI {
  constructor({ store, net, interactions, board, identity, onRoomChange }) {
    this.store = store;
    this.net = net;
    this.interactions = interactions;
    this.board = board;
    this.identity = identity;
    this.onRoomChange = onRoomChange;
    this._logs = [];

    this.$ = (id) => document.getElementById(id);

    this.el = {
      status: this.$('status'),
      statusText: this.$('status-text'),
      members: this.$('members'),
      toolbar: this.$('toolbar'),
      undo: this.$('undo-btn'),
      redo: this.$('redo-btn'),
      deleteBtn: this.$('delete-btn'),
      zoomBtn: this.$('zoom-btn'),
      fill: this.$('fill-input'),
      fillNone: this.$('fill-none'),
      stroke: this.$('stroke-input'),
      strokeWidth: this.$('stroke-width-input'),
      strokeWidthOut: this.$('stroke-width-out'),
      fontSize: this.$('font-size-input'),
      fontSizeOut: this.$('font-size-out'),
      selectionCard: this.$('selection-card'),
      debug: this.$('debug'),
      debugToggle: this.$('debug-toggle'),
      debugClose: this.$('debug-close'),
      debugOffline: this.$('dbg-offline'),
      debugLog: this.$('debug-log'),
      roomInput: this.$('room-input'),
      copyLink: this.$('copy-link'),
      toastHost: this.$('toast-host'),
      hintBar: this.$('hint-bar'),
    };

    this._bind();
    this.syncTool('select');
    this.refresh();
  }

  _bind() {
    const { el, interactions } = this;

    el.toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tool]');
      if (btn) interactions.setTool(btn.dataset.tool);
    });

    el.undo.addEventListener('click', () => interactions.doUndo());
    el.redo.addEventListener('click', () => interactions.doRedo());
    el.deleteBtn.addEventListener('click', () => interactions.deleteSelection());
    el.zoomBtn.addEventListener('click', () => {
      this.board.resetView();
      this.onViewportChange?.();
    });

    el.fill.addEventListener('input', () => {
      interactions.applyStyleToSelection({ fill: el.fill.value });
    });
    el.fillNone.addEventListener('click', () => {
      interactions.applyStyleToSelection({ fill: 'transparent' });
      this.toast('填充已设为透明');
    });
    el.stroke.addEventListener('input', () => {
      interactions.applyStyleToSelection({ stroke: el.stroke.value });
    });
    el.strokeWidth.addEventListener('input', () => {
      el.strokeWidthOut.textContent = el.strokeWidth.value;
      interactions.applyStyleToSelection({ strokeWidth: Number(el.strokeWidth.value) });
    });
    el.fontSize.addEventListener('input', () => {
      el.fontSizeOut.textContent = el.fontSize.value;
      interactions.applyStyleToSelection({ fontSize: Number(el.fontSize.value) });
    });

    el.debugToggle.addEventListener('click', () => this.toggleDebug());
    el.debugClose.addEventListener('click', () => this.toggleDebug(false));
    el.debugOffline.addEventListener('change', () => {
      this.net.setSimulatedOffline(el.debugOffline.checked);
    });

    el.copyLink.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        this.toast('房间链接已复制', 'ok');
      } catch {
        this.toast(`复制失败，请手动复制：${location.href}`, 'warn');
      }
    });

    el.roomInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const next = el.roomInput.value.trim();
      if (!next) return;
      this.onRoomChange?.(next);
    });

    // 提示条 6 秒后淡出，别一直挡着画布
    setTimeout(() => el.hintBar.classList.add('is-hidden'), 6000);
  }

  syncTool(name) {
    for (const btn of this.el.toolbar.querySelectorAll('[data-tool]')) {
      btn.classList.toggle('is-active', btn.dataset.tool === name);
    }
  }

  setState(state) {
    const el = this.el.status;
    el.dataset.state = state;
    this.el.statusText.textContent = STATE_LABEL[state] || state;
    this.el.debugOffline.disabled = state === 'connecting';
    this.refresh();
  }

  setMembers(list) {
    const host = this.el.members;
    host.innerHTML = '';
    for (const m of list.slice(0, 6)) {
      const div = document.createElement('div');
      div.className = 'member-avatar';
      div.style.background = m.color || '#64748b';
      div.title = m.name || '访客';
      div.textContent = (m.name || '访').slice(0, 1);
      host.appendChild(div);
    }
    if (list.length > 6) {
      const more = document.createElement('div');
      more.className = 'member-avatar';
      more.style.background = '#94a3b8';
      more.textContent = `+${list.length - 6}`;
      host.appendChild(more);
    }
  }

  updateSelection() {
    const ids = [...this.interactions.getSelection()];
    const card = this.el.selectionCard;
    this.el.deleteBtn.disabled = ids.length === 0;

    if (!ids.length) {
      card.innerHTML = '<span class="muted">未选中图形</span>';
      return;
    }
    if (ids.length > 1) {
      card.innerHTML = `<strong>已选中 ${ids.length} 个图形</strong>`;
      return;
    }
    const flat = this.store.flat(ids[0]);
    if (!flat) {
      card.innerHTML = '<span class="muted">未选中图形</span>';
      return;
    }
    const typeName = flat.type === 'rect' ? '矩形' : flat.type === 'ellipse' ? '椭圆' : '文本';
    card.innerHTML = `
      <strong>${typeName}</strong><br />
      <span class="muted">位置</span> ${Math.round(flat.x)}, ${Math.round(flat.y)}<br />
      <span class="muted">尺寸</span> ${Math.round(flat.w)} × ${Math.round(flat.h)}<br />
      <span class="muted">版本</span> v${this.store.getShape(ids[0]) ? maxVer(this.store.getShape(ids[0])) : 1}<br />
      <span class="muted">id</span> ${ids[0].slice(0, 8)}
    `;

    // 面板回填当前图形样式（正在拖颜色选择器时不要抢焦点）
    const active = document.activeElement;
    const editingPanel = active && active.tagName === 'INPUT' && active.closest('.inspector');
    if (editingPanel) return;

    if (flat.fill && flat.fill !== 'transparent') this.el.fill.value = flat.fill;
    if (flat.stroke && flat.stroke !== 'transparent') this.el.stroke.value = flat.stroke;
    this.el.strokeWidth.value = String(flat.strokeWidth ?? 2);
    this.el.strokeWidthOut.textContent = String(flat.strokeWidth ?? 2);
    this.el.fontSize.value = String(flat.fontSize ?? 20);
    this.el.fontSizeOut.textContent = String(flat.fontSize ?? 20);
  }

  updateZoom(text) {
    this.el.zoomBtn.textContent = text;
  }

  refresh() {
    this.el.undo.disabled = !this.store.canUndo();
    this.el.redo.disabled = !this.store.canRedo();
    this.updateStats();
  }

  updateStats() {
    const s = this.net.stats();
    const d = this.store.stats();
    const set = (id, v) => {
      const node = document.getElementById(id);
      if (node) node.textContent = String(v);
    };
    set('dbg-state', STATE_LABEL[s.state] || s.state);
    set('dbg-seq', s.lastApplied);
    set('dbg-queue', d.pending);
    set('dbg-shapes', `${d.visible} / ${d.total}`);
    set('dbg-traffic', `${s.recv} / ${s.sent}`);
    set('dbg-epoch', s.bootEpoch ? s.bootEpoch.slice(0, 12) : '-');
    set('dbg-retry', s.retries);
    if (this.el.debugOffline.checked !== this.net.simulatedOffline) {
      this.el.debugOffline.checked = this.net.simulatedOffline;
    }
  }

  toggleDebug(force) {
    const show = force === undefined ? this.el.debug.hidden : force;
    this.el.debug.hidden = !show;
    this.el.debugToggle.classList.toggle('is-active', show);
    if (show) this.updateStats();
  }

  log(level, message) {
    const time = new Date().toTimeString().slice(0, 8);
    this._logs.push({ time, level, message });
    if (this._logs.length > LOG_LIMIT) this._logs.shift();

    const host = this.el.debugLog;
    const line = document.createElement('div');
    line.className = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : level === 'err' ? 'err' : '';
    line.innerHTML = `<span class="t">${time}</span> ${escapeHtml(message)}`;
    host.appendChild(line);
    while (host.childElementCount > LOG_LIMIT) host.removeChild(host.firstElementChild);
    host.scrollTop = host.scrollHeight;
  }

  toast(message, kind = '') {
    const host = this.el.toastHost;
    while (host.childElementCount >= 3) host.removeChild(host.firstElementChild);
    const div = document.createElement('div');
    div.className = `toast ${kind}`;
    div.textContent = message;
    host.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      div.style.transition = 'opacity .3s';
      setTimeout(() => div.remove(), 320);
    }, 2200);
  }
}

function maxVer(shape) {
  let max = 0;
  for (const cell of Object.values(shape.fields)) if (cell.v > max) max = cell.v;
  return max;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
