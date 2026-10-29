/**
 * UI 装配层：工具栏、属性面板、状态条、弹层、调试面板、Toast。
 * 只做 DOM 与事件绑定，所有状态变更都转发给 store / interactions / net。
 */

import { roomUrl } from './rooms.js';
import { flatten } from '../../shared/merge.js';

const STATE_LABEL = {
  idle: '未连接',
  connecting: '连接中…',
  syncing: '同步中…',
  online: '已连接',
  offline: '离线（本地可编辑）',
};

const LOG_LIMIT = 40;

/** 全局 Toast：落地页与白板共用同一个宿主节点 */
export function toast(message, kind = '') {
  const host = document.getElementById('toast-host');
  if (!host) return;
  while (host.childElementCount >= 3) host.removeChild(host.firstElementChild);

  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = message;
  host.appendChild(div);

  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transition = 'opacity .3s';
    setTimeout(() => div.remove(), 320);
  }, 2400);
}

export class UI {
  constructor({ store, net, interactions, board, identity, onRoomChange }) {
    this.store = store;
    this.net = net;
    this.interactions = interactions;
    this.board = board;
    this.identity = identity;
    this.onRoomChange = onRoomChange;
    this._logs = [];
    this._openPop = null;

    this.$ = (id) => document.getElementById(id);

    this.el = {
      status: this.$('status'),
      statusText: this.$('status-text'),
      members: this.$('members'),
      membersCount: this.$('members-count'),
      toolbar: this.$('toolbar'),
      undo: this.$('undo-btn'),
      redo: this.$('redo-btn'),
      deleteBtn: this.$('delete-btn'),
      zoomBtn: this.$('zoom-btn'),
      zoomIn: this.$('zoom-in'),
      zoomOut: this.$('zoom-out'),
      zoomFit: this.$('zoom-fit'),
      fill: this.$('fill-input'),
      fillNone: this.$('fill-none'),
      fillSwatches: this.$('fill-swatches'),
      stroke: this.$('stroke-input'),
      strokeWidth: this.$('stroke-width-input'),
      strokeWidthOut: this.$('stroke-width-out'),
      fontSize: this.$('font-size-input'),
      fontSizeOut: this.$('font-size-out'),
      selectionCard: this.$('selection-card'),
      selBadge: this.$('sel-badge'),
      inspectorEmpty: this.$('inspector-empty'),
      inspectorBody: this.$('inspector-body'),
      numX: this.$('num-x'),
      numY: this.$('num-y'),
      numW: this.$('num-w'),
      numH: this.$('num-h'),
      layerFront: this.$('layer-front'),
      layerBack: this.$('layer-back'),
      emptyState: this.$('empty-state'),
      debug: this.$('debug'),
      debugToggle: this.$('debug-toggle'),
      debugClose: this.$('debug-close'),
      debugOffline: this.$('dbg-offline'),
      debugLog: this.$('debug-log'),
      roomChip: this.$('room-chip'),
      roomChipId: this.$('room-chip-id'),
      copyLink: this.$('copy-link'),
      sharePop: this.$('share-pop'),
      shareLink: this.$('share-link'),
      shareCopy: this.$('share-copy'),
      switchRoom: this.$('switch-room'),
      helpToggle: this.$('help-toggle'),
      helpPop: this.$('help-pop'),
      exportPng: this.$('export-png'),
      toastHost: this.$('toast-host'),
      hintBar: this.$('hint-bar'),
    };

    this.el.roomChipId.textContent = this.store.roomId;
    this.el.shareLink.value = roomUrl(this.store.roomId);

    this._bind();
    this.syncTool('select');
    this.refresh();
    this.updateSelection();
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

    // 画布空状态里的快捷工具
    el.emptyState.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-quick]');
      if (!btn) return;
      interactions.setTool(btn.dataset.quick);
      toast('在画布上拖拽即可绘制');
    });

    // 缩放
    el.zoomBtn.addEventListener('click', () => {
      this.board.resetView();
      this.onViewportChange?.();
    });
    el.zoomIn.addEventListener('click', () => this._zoom(1.2));
    el.zoomOut.addEventListener('click', () => this._zoom(1 / 1.2));
    el.zoomFit.addEventListener('click', () => {
      const ok = this.board.fitContent();
      this.onViewportChange?.();
      if (!ok) toast('画布上还没有图形');
    });

    // 样式：拖动期间走「样式事务」——只应用、不逐帧记撤销，
    // 松手（change）时把整段变化合并成一条。
    // 原来直接绑在 input 上提交：拖一次滑块会产生十几条 op + 十几条 undo，
    // Ctrl+Z 要按十几次才回到原色，还容易撞服务端限流。
    const beginStyle = () => interactions.beginStyleEdit();
    const endStyle = () => interactions.endStyleEdit();

    el.fill.addEventListener('input', () => {
      beginStyle();
      interactions.applyStyleToSelection({ fill: el.fill.value });
    });
    el.fill.addEventListener('change', endStyle);
    el.fillSwatches.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-color]');
      if (!btn) return;
      el.fill.value = btn.dataset.color;
      interactions.applyStyleToSelection({ fill: btn.dataset.color });
    });
    el.fillNone.addEventListener('click', () => {
      interactions.applyStyleToSelection({ fill: 'transparent' });
      toast('填充已设为透明');
    });
    el.stroke.addEventListener('input', () => {
      beginStyle();
      interactions.applyStyleToSelection({ stroke: el.stroke.value });
    });
    el.stroke.addEventListener('change', endStyle);
    el.strokeWidth.addEventListener('input', () => {
      el.strokeWidthOut.textContent = el.strokeWidth.value;
      beginStyle();
      interactions.applyStyleToSelection({ strokeWidth: Number(el.strokeWidth.value) });
    });
    el.strokeWidth.addEventListener('change', endStyle);
    el.fontSize.addEventListener('input', () => {
      el.fontSizeOut.textContent = el.fontSize.value;
      beginStyle();
      interactions.applyStyleToSelection({ fontSize: Number(el.fontSize.value) });
    });
    el.fontSize.addEventListener('change', endStyle);

    // 位置与尺寸：输入完成（change / 回车）才提交，避免打字过程中每键一条 op
    for (const [input, field] of [
      [el.numX, 'x'],
      [el.numY, 'y'],
      [el.numW, 'w'],
      [el.numH, 'h'],
    ]) {
      const commit = () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        const ids = [...interactions.getSelection()];
        if (ids.length !== 1) return;
        interactions.applyStyleToSelection({ [field]: Math.round(value) });
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          input.blur();
        }
      });
    }

    // 层级
    el.layerFront.addEventListener('click', () => {
      interactions.applyStyleToSelection({ z: Date.now() });
      toast('已置顶');
    });
    el.layerBack.addEventListener('click', () => {
      // 取所有图形里最小的 z 再减一。注意 list() 返回的是带戳的图形，
      // z 在字段里（fields.z.val），必须过一遍 flatten 才拿得到。
      const list = this.store.list().map((s) => flatten(s));
      const minZ = list.length ? Math.min(...list.map((s) => s.z ?? 0)) : 0;
      interactions.applyStyleToSelection({ z: Math.max(0, minZ - 1) });
      toast('已置底');
    });

    // 房间 / 分享
    el.roomChip.addEventListener('click', () => this.togglePopover(el.sharePop, el.roomChip));
    el.copyLink.addEventListener('click', () => this._copyLink());
    el.shareCopy.addEventListener('click', () => this._copyLink());
    el.shareLink.addEventListener('focus', () => el.shareLink.select());
    el.switchRoom.addEventListener('click', () => {
      this.store.flush();
      location.href = '/';
    });

    el.helpToggle.addEventListener('click', () => this.togglePopover(el.helpPop, el.helpToggle));
    el.exportPng?.addEventListener('click', () => this._exportPNG());

    // 点空白处关弹层；Esc 也关
    document.addEventListener('pointerdown', (e) => {
      if (!this._openPop) return;
      const { node, trigger } = this._openPop;
      if (node.contains(e.target) || trigger.contains(e.target)) return;
      this.closePopovers();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePopovers();
    });

    // 调试
    el.debugToggle.addEventListener('click', () => this.toggleDebug());
    el.debugClose.addEventListener('click', () => this.toggleDebug(false));
    el.debugOffline.addEventListener('change', () => {
      this.net.setSimulatedOffline(el.debugOffline.checked);
    });

    // 提示条 7 秒后淡出，别一直挡着画布
    setTimeout(() => el.hintBar.classList.add('is-hidden'), 7000);
  }

  _zoom(factor) {
    const pt = { x: this.board.width / 2, y: this.board.height / 2 };
    this.board.zoomAt(pt, factor);
    this.onViewportChange?.();
  }

  async _copyLink() {
    const url = roomUrl(this.store.roomId);
    try {
      await navigator.clipboard.writeText(url);
      toast('邀请链接已复制，发给对方即可进入同一房间', 'ok');
    } catch {
      this.el.shareLink.select();
      toast(`复制失败，请手动复制：${url}`, 'warn');
    }
  }

  async _exportPNG() {
    const blob = await this.board.toPNGBlob({ padding: 32, scale: 2 });
    if (!blob) {
      toast('画布上还没有图形', 'warn');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whiteboard-${this.store.roomId}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会让部分浏览器的下载中断，等一拍再释放
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出 PNG', 'ok');
  }

  togglePopover(node, trigger) {
    const willOpen = node.hidden;
    this.closePopovers();
    if (!willOpen) return;
    node.hidden = false;
    trigger.classList.add('is-active');
    this._openPop = { node, trigger };
    if (node === this.el.sharePop) this.el.shareLink.select();
  }

  closePopovers() {
    if (!this._openPop) return;
    this._openPop.node.hidden = true;
    this._openPop.trigger.classList.remove('is-active');
    this._openPop = null;
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
    for (const m of list.slice(0, 5)) {
      const div = document.createElement('div');
      div.className = 'member-avatar';
      div.style.background = m.color || '#64748b';
      div.title = `${m.name || '访客'}${m.clientId === this.identity.clientId ? '（你）' : ''}`;
      div.textContent = avatarText(m.name);
      host.appendChild(div);
    }
    if (list.length > 5) {
      const more = document.createElement('div');
      more.className = 'member-avatar';
      more.style.background = '#94a3b8';
      more.textContent = `+${list.length - 5}`;
      host.appendChild(more);
    }
    this.el.membersCount.textContent = list.length ? `${list.length} 人在线` : '';
  }

  updateSelection() {
    const ids = [...this.interactions.getSelection()];
    const { el } = this;
    el.deleteBtn.disabled = ids.length === 0;
    el.layerFront.disabled = ids.length === 0;
    el.layerBack.disabled = ids.length === 0;

    if (!ids.length) {
      el.selBadge.textContent = '未选中';
      el.selBadge.removeAttribute('data-state');
      el.inspectorEmpty.hidden = false;
      el.inspectorBody.hidden = true;
      return;
    }

    el.inspectorEmpty.hidden = true;
    el.inspectorBody.hidden = false;

    if (ids.length > 1) {
      el.selBadge.textContent = `已选 ${ids.length} 个`;
      el.selBadge.dataset.state = 'active';
      for (const input of [el.numX, el.numY, el.numW, el.numH]) {
        input.value = '';
        input.disabled = true;
      }
      el.selectionCard.innerHTML = `<strong>已选中 ${ids.length} 个图形</strong><br /><span class="muted">样式与层级修改会应用到全部选中项</span>`;
      return;
    }

    const flat = this.store.flat(ids[0]);
    if (!flat) {
      el.selBadge.textContent = '未选中';
      el.inspectorEmpty.hidden = false;
      el.inspectorBody.hidden = true;
      return;
    }

    const typeName =
      flat.type === 'rect'
        ? '矩形'
        : flat.type === 'ellipse'
          ? '椭圆'
          : flat.type === 'pen'
            ? '画笔'
            : '文本';
    el.selBadge.textContent = typeName;
    el.selBadge.dataset.state = 'active';

    // 面板回填当前图形属性（正在拖颜色选择器/改数字时不要抢焦点）
    const active = document.activeElement;
    const editing = active && active.tagName === 'INPUT' && active.closest('.inspector');

    if (!editing) {
      el.numX.value = String(Math.round(flat.x));
      el.numY.value = String(Math.round(flat.y));
      el.numW.value = String(Math.round(flat.w));
      el.numH.value = String(Math.round(flat.h));
    }
    for (const input of [el.numX, el.numY, el.numW, el.numH]) input.disabled = false;

    if (!editing) {
      if (flat.fill && flat.fill !== 'transparent') el.fill.value = flat.fill;
      if (flat.stroke && flat.stroke !== 'transparent') el.stroke.value = flat.stroke;
      el.strokeWidth.value = String(flat.strokeWidth ?? 2);
      el.strokeWidthOut.textContent = String(flat.strokeWidth ?? 2);
      el.fontSize.value = String(flat.fontSize ?? 20);
      el.fontSizeOut.textContent = String(flat.fontSize ?? 20);
    }

    const shape = this.store.getShape(ids[0]);
    el.selectionCard.innerHTML = `
      <span class="muted">位置</span> ${Math.round(flat.x)}, ${Math.round(flat.y)} &nbsp;·&nbsp;
      <span class="muted">尺寸</span> ${Math.round(flat.w)} × ${Math.round(flat.h)}<br />
      <span class="muted">版本</span> v${shape ? maxVer(shape) : 1} &nbsp;·&nbsp;
      <span class="muted">id</span> ${ids[0].slice(0, 8)}
    `;
  }

  updateZoom(text) {
    this.el.zoomBtn.textContent = text;
  }

  refresh() {
    this.el.undo.disabled = !this.store.canUndo();
    this.el.redo.disabled = !this.store.canRedo();
    this.updateEmptyState();
    this.updateStats();
  }

  /** 画布上没有图形时给一段上手引导，画了第一笔就淡出 */
  updateEmptyState() {
    const stats = this.store.stats();
    this.el.emptyState.classList.toggle('is-hidden', stats.visible > 0);
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
    toast(message, kind);
  }
}

/**
 * 头像文字：默认昵称都是「访客-xxxx」，只取首字会变成一排一模一样的「访」，
 * 所以访客取尾号两位，其他昵称取前两个字。
 */
function avatarText(name) {
  const n = String(name || '').trim();
  const guest = n.match(/^访客[-_]?(.*)$/);
  if (guest) {
    const tail = guest[1].replace(/[^0-9a-zA-Z]/g, '');
    return (tail.slice(0, 2) || '访').toUpperCase();
  }
  return n.slice(0, 2) || '访';
}

function maxVer(shape) {
  let max = 0;
  for (const cell of Object.values(shape.fields)) if (cell.v > max) max = cell.v;
  return max;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
