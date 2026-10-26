/**
 * 交互控制：工具状态机 + 指针事件处理。
 *
 * 拖动/缩放期间的做法：
 *   鼠标移动时只更新「预览」（画布直接画出来，手感是零延迟的），
 *   每 60ms 才把当前几何提交成一条 op；松开时补一次最终提交。
 *   这样既有即时反馈，又不会因为一次拖动产生几百条 op。
 *   撤销记录在拖动结束时合并成一条，避免用户按一次 Ctrl+Z 只退回 1 像素。
 */

import { Board } from './canvas.js';

const COMMIT_INTERVAL = 60;
const MIN_SHAPE = 4;
const DEFAULT_W = 160;
const DEFAULT_H = 110;
const MIN_DRAG = 3;

export class Interactions {
  constructor({ canvasEl, board, store, net, ui, editorWrap, editor }) {
    this.canvasEl = canvasEl;
    this.board = board;
    this.store = store;
    this.net = net;
    this.ui = ui;
    this.editorWrap = editorWrap;
    this.editor = editor;

    this.tool = 'select';
    this.selection = new Set();
    this.preview = new Map(); // shapeId → patch（拖动预览）
    this.draft = null; // 正在绘制的新图形
    this.marquee = null;
    this.drag = null;
    this.spaceDown = false;

    this.style = {
      fill: '#dbeafe',
      stroke: '#1e293b',
      strokeWidth: 2,
      fontSize: 20,
      textColor: '#0f172a',
    };

    this._lastCommit = 0;
    this._editorState = null;
    this._measureCtx = document.createElement('canvas').getContext('2d');

    this._bind();
  }

  // ── 事件绑定 ─────────────────────────────────────────────

  _bind() {
    const el = this.canvasEl;

    el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    el.addEventListener('pointerleave', () => {
      this.onCursor?.(null);
    });
    el.addEventListener('dblclick', (e) => this._onDoubleClick(e));
    el.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this._updateCursor();
      }
    });
    window.addEventListener('blur', () => {
      this.spaceDown = false;
    });

    this.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeTextEditor(true);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._commitText();
      }
      e.stopPropagation();
    });
    this.editor.addEventListener('input', () => this._autoGrow());
    this.editor.addEventListener('blur', () => this._commitText());
  }

  // ── 工具与选择 ───────────────────────────────────────────

  setTool(name) {
    if (this.tool === name) return;
    this.tool = name;
    this.draft = null;
    this.preview.clear();
    if (name !== 'select') this.selection.clear();
    this.canvasEl.className = `tool-${name}`;
    this.board.render();
    this.ui?.syncTool(name);
    this.ui?.updateSelection();
    this._updateCursor();
  }

  getSelection() {
    return this.selection;
  }

  selectAll() {
    this.selection = new Set(this.store.list().map((s) => s.id));
    this.ui?.updateSelection();
    this.board.render();
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.ui?.updateSelection();
    this.board.render();
  }

  deleteSelection() {
    if (!this.selection.size) return;
    for (const id of [...this.selection]) this.store.deleteShape(id);
    this.selection.clear();
    this.ui?.updateSelection();
    this.board.render();
  }

  applyStyleToSelection(patch) {
    Object.assign(this.style, patch);
    if (!this.selection.size) return;
    for (const id of this.selection) this.store.applyLocal(id, { ...patch }, { label: '修改样式' });
    this.board.render();
  }

  /** 撤销/重做后清理已不存在或已删除的选中项 */
  pruneSelection() {
    let changed = false;
    for (const id of [...this.selection]) {
      const flat = this.store.flat(id);
      if (!flat || flat.deleted) {
        this.selection.delete(id);
        changed = true;
      }
    }
    if (changed) this.ui?.updateSelection();
  }

  // ── 指针事件 ─────────────────────────────────────────────

  _onPointerDown(e) {
    try {
      this.canvasEl.setPointerCapture(e.pointerId);
    } catch {
      // 合成事件（自动化测试）没有活跃指针，捕获失败不影响后续逻辑
    }
    const sp = this.board.eventPoint(e);
    const wp = this.board.screenToWorld(sp);

    if (e.button === 1 || this.spaceDown) {
      e.preventDefault();
      this.drag = { mode: 'pan', last: sp };
      this.canvasEl.classList.add('is-panning');
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'select') {
      const handle = this.board.handleAt(sp);
      if (handle) {
        this._startResize(handle, wp);
        return;
      }
      const hit = this.board.hitTest(wp);
      if (hit) {
        if (e.shiftKey) {
          if (this.selection.has(hit)) this.selection.delete(hit);
          else this.selection.add(hit);
        } else if (!this.selection.has(hit)) {
          this.selection = new Set([hit]);
        }
        this.ui?.updateSelection();
        if (this.selection.has(hit)) this._startMove(wp);
        this.board.render();
        return;
      }
      if (!e.shiftKey) this.selection.clear();
      this.ui?.updateSelection();
      this.drag = { mode: 'marquee', start: wp };
      this.marquee = { x: wp.x, y: wp.y, w: 0, h: 0 };
      this.board.render();
      return;
    }

    if (this.tool === 'rect' || this.tool === 'ellipse') {
      this.drag = { mode: 'create', start: wp };
      this.draft = this._draftFor(this.tool, wp, wp);
      this.board.render();
      return;
    }

    if (this.tool === 'text') {
      this._openTextEditor({ world: wp, fontSize: this.style.fontSize });
    }
  }

  _onPointerMove(e) {
    const sp = this.board.eventPoint(e);
    const wp = this.board.screenToWorld(sp);
    this.onCursor?.(wp);

    if (!this.drag) {
      if (this.tool === 'select') {
        const handle = this.board.handleAt(sp);
        this.canvasEl.style.cursor = handle ? Board.cursorFor(handle) : this.board.hitTest(wp) ? 'move' : 'default';
      }
      return;
    }

    if (this.drag.mode === 'pan') {
      this.board.panBy(sp.x - this.drag.last.x, sp.y - this.drag.last.y);
      this.drag.last = sp;
      this.onViewportChange?.();
      return;
    }

    if (this.drag.mode === 'marquee') {
      const s = this.drag.start;
      this.marquee = normalizeRect(s.x, s.y, wp.x, wp.y);
      this.board.render();
      return;
    }

    if (this.drag.mode === 'create') {
      this.draft = this._draftFor(this.drag.type || this.tool, this.drag.start, wp, e.shiftKey);
      this.board.render();
      return;
    }

    if (this.drag.mode === 'move') {
      const dx = wp.x - this.drag.start.x;
      const dy = wp.y - this.drag.start.y;
      if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2 && !this.drag.moved) return;
      this.drag.moved = true;
      this.preview.clear();
      for (const [id, origin] of this.drag.origins) {
        this.preview.set(id, { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) });
      }
      this.board.render();
      this._throttleCommit();
      return;
    }

    if (this.drag.mode === 'resize') {
      const rect = resizeRect(this.drag.origin, this.drag.handle, wp);
      this.preview.set(this.drag.id, rect);
      this.board.render();
      this._throttleCommit();
    }
  }

  _onPointerUp(e) {
    if (!this.drag) return;
    const mode = this.drag.mode;

    if (mode === 'pan') {
      this.canvasEl.classList.remove('is-panning');
      this.drag = null;
      this._updateCursor();
      return;
    }

    if (mode === 'marquee') {
      const picked = this.marquee ? this.board.shapesInRect(this.marquee) : [];
      this.selection = new Set([...this.selection, ...picked]);
      this.marquee = null;
      this.drag = null;
      this.ui?.updateSelection();
      this.board.render();
      return;
    }

    if (mode === 'create') {
      const draft = this.draft;
      this.draft = null;
      this.drag = null;
      if (draft) {
        const w = draft.w >= MIN_DRAG ? draft.w : DEFAULT_W;
        const h = draft.h >= MIN_DRAG ? draft.h : DEFAULT_H;
        const x = draft.w >= MIN_DRAG ? draft.x : draft.x - w / 2;
        const y = draft.h >= MIN_DRAG ? draft.y : draft.y - h / 2;
        const { id } = this.store.createShape({
          type: draft.type,
          x,
          y,
          w,
          h,
          fill: this.style.fill,
          stroke: this.style.stroke,
          strokeWidth: this.style.strokeWidth,
          fontSize: this.style.fontSize,
          text: draft.type === 'text' ? '' : undefined,
        });
        this.selection = new Set([id]);
        this.setTool('select');
        this.ui?.updateSelection();
      }
      this.board.render();
      return;
    }

    if (mode === 'move' || mode === 'resize') {
      const drag = this.drag;
      this.drag = null;
      const patches = new Map(this.preview);
      this.preview.clear();
      this._commitPatches(patches);

      if (drag.moved && drag.originsFlat) {
        // 拖动过程中的中间 op 不单独记撤销，这里合并成一条
        const items = [];
        for (const id of Object.keys(drag.originsFlat)) {
          const flat = this.store.flat(id);
          const origin = drag.originsFlat[id];
          if (!flat) continue;
          const fwd = {};
          const back = {};
          let changed = false;
          for (const key of Object.keys(origin)) {
            fwd[key] = flat[key];
            back[key] = origin[key];
            if (fwd[key] !== back[key]) changed = true;
          }
          if (changed) {
            items.push({
              id,
              forward: { kind: 'patch', patch: fwd },
              backward: { kind: 'patch', patch: back },
            });
          }
        }
        if (items.length) {
          this.store.recordUndo({ label: mode === 'resize' ? '缩放' : '移动', items });
        }
      }
      this.board.render();
      this.ui?.refresh();
    }
  }

  _onDoubleClick(e) {
    const sp = this.board.eventPoint(e);
    const wp = this.board.screenToWorld(sp);
    const hit = this.board.hitTest(wp);
    if (!hit) return;
    const shape = this.store.getShape(hit);
    const flat = this.store.flat(hit);
    if (!shape || !flat || flat.type !== 'text') return;
    this.selection = new Set([hit]);
    this.ui?.updateSelection();
    this._openTextEditor({ shapeId: hit, world: { x: flat.x, y: flat.y }, initial: flat.text || '', fontSize: flat.fontSize || 20 });
  }

  _onWheel(e) {
    e.preventDefault();
    const sp = this.board.eventPoint(e);
    if (e.shiftKey) {
      this.board.panBy(-e.deltaY, 0);
      this.onViewportChange?.();
      return;
    }
    const factor = Math.exp(-e.deltaY * 0.0016);
    this.board.zoomAt(sp, factor);
    this.onViewportChange?.();
  }

  _onKeyDown(e) {
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing) return;

    const meta = e.ctrlKey || e.metaKey;

    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.doRedo();
      else this.doUndo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.doRedo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (meta && (e.key === '0' || e.key === '=' || e.key === '-' || e.key === '+')) {
      e.preventDefault();
      if (e.key === '0') this.board.resetView();
      else this.board.zoomAt({ x: this.board.width / 2, y: this.board.height / 2 }, e.key === '-' ? 0.85 : 1.18);
      this.onViewportChange?.();
      return;
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.deleteSelection();
        return;
      case 'Escape':
        this.clearSelection();
        this.draft = null;
        this.board.render();
        return;
      case ' ':
        if (!this.spaceDown) {
          this.spaceDown = true;
          this._updateCursor();
        }
        e.preventDefault();
        return;
      case 'v':
      case 'V':
        this.setTool('select');
        return;
      case 'r':
      case 'R':
        this.setTool('rect');
        return;
      case 'o':
      case 'O':
        this.setTool('ellipse');
        return;
      case 't':
      case 'T':
        this.setTool('text');
        return;
      default:
        return;
    }
  }

  doUndo() {
    if (this.store.undo()) {
      this.pruneSelection();
      this.board.render();
      this.ui?.refresh();
      this.ui?.toast('已撤销');
    } else {
      this.ui?.toast('没有可撤销的操作');
    }
  }

  doRedo() {
    if (this.store.redo()) {
      this.pruneSelection();
      this.board.render();
      this.ui?.refresh();
      this.ui?.toast('已重做');
    } else {
      this.ui?.toast('没有可重做的操作');
    }
  }

  // ── 拖动 / 缩放 ──────────────────────────────────────────

  _startMove(wp) {
    const origins = new Map();
    const originsFlat = {};
    for (const id of this.selection) {
      const flat = this.store.flat(id);
      if (!flat || flat.deleted) continue;
      origins.set(id, { x: flat.x, y: flat.y });
      originsFlat[id] = { x: flat.x, y: flat.y };
    }
    if (!origins.size) return;
    this.drag = { mode: 'move', start: wp, origins, originsFlat, moved: false };
  }

  _startResize(handle, wp) {
    const id = [...this.selection][0];
    const flat = this.store.flat(id);
    if (!flat) return;
    this.drag = {
      mode: 'resize',
      id,
      handle,
      start: wp,
      origin: { x: flat.x, y: flat.y, w: flat.w, h: flat.h },
      originsFlat: { [id]: { x: flat.x, y: flat.y, w: flat.w, h: flat.h } },
      moved: false,
    };
    this.drag.origins = new Map([[id, { x: flat.x, y: flat.y }]]);
  }

  _throttleCommit() {
    const now = performance.now();
    if (now - this._lastCommit < COMMIT_INTERVAL) return;
    this._lastCommit = now;
    this.drag.moved = true;
    const patches = new Map(this.preview);
    this.preview.clear();
    this._commitPatches(patches);
  }

  _commitPatches(patches) {
    if (!patches.size) return;
    if (patches.size === 1) {
      const [id, patch] = [...patches.entries()][0];
      this.store.applyLocal(id, patch, { record: false });
    } else {
      for (const [id, patch] of patches) this.store.applyLocal(id, patch, { record: false });
    }
  }

  // ── 文本编辑 ─────────────────────────────────────────────

  _openTextEditor({ world, shapeId = null, initial = '', fontSize = 20 }) {
    const screen = this.board.worldToScreen(world);
    const scale = this.board.viewport.scale;
    this.editorWrap.hidden = false;
    this.editorWrap.style.left = `${Math.round(screen.x)}px`;
    this.editorWrap.style.top = `${Math.round(screen.y)}px`;
    this.editor.style.fontSize = `${Math.max(10, fontSize * scale)}px`;
    this.editor.style.width = `${Math.max(90, 200 * scale)}px`;
    this.editor.value = initial;
    this._editorState = { shapeId, world, fontSize };
    this._autoGrow();
    requestAnimationFrame(() => {
      this.editor.focus();
      if (initial) this.editor.select();
    });
  }

  _autoGrow() {
    this.editor.style.height = 'auto';
    this.editor.style.height = `${this.editor.scrollHeight}px`;
  }

  _closeTextEditor(cancel = false) {
    if (!this._editorState) return;
    this._editorState = null;
    this.editorWrap.hidden = true;
    this.editor.value = '';
    if (!cancel) this.board.render();
  }

  _commitText() {
    const state = this._editorState;
    if (!state) return;
    const text = this.editor.value.replace(/\r/g, '');
    const fontSize = state.fontSize;
    this._closeTextEditor(true);

    if (state.shapeId) {
      const flat = this.store.flat(state.shapeId);
      if (!flat) return;
      if (!text.trim()) {
        this.store.deleteShape(state.shapeId);
        this.selection.delete(state.shapeId);
      } else {
        const size = measureTextBox(this._measureCtx, text, fontSize);
        this.store.applyLocal(state.shapeId, { text, w: size.w, h: size.h }, { label: '编辑文本' });
      }
    } else if (text.trim()) {
      const size = measureTextBox(this._measureCtx, text, fontSize);
      const { id } = this.store.createShape({
        type: 'text',
        x: Math.round(state.world.x),
        y: Math.round(state.world.y),
        w: size.w,
        h: size.h,
        text,
        fill: this.style.textColor,
        stroke: 'transparent',
        strokeWidth: 0,
        fontSize,
      });
      this.selection = new Set([id]);
      this.setTool('select');
    }

    this.ui?.updateSelection();
    this.board.render();
    this.ui?.refresh();
  }

  // ── 杂项 ─────────────────────────────────────────────────

  _draftFor(type, start, current, constrain = false) {
    let rect = normalizeRect(start.x, start.y, current.x, current.y);
    if (constrain) {
      const size = Math.max(rect.w, rect.h);
      rect = {
        x: current.x < start.x ? start.x - size : start.x,
        y: current.y < start.y ? start.y - size : start.y,
        w: size,
        h: size,
      };
    }
    return {
      type,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.max(MIN_SHAPE, Math.round(rect.w)),
      h: Math.max(MIN_SHAPE, Math.round(rect.h)),
      fill: this.style.fill,
      stroke: this.style.stroke,
      strokeWidth: this.style.strokeWidth,
      text: '',
      fontSize: this.style.fontSize,
    };
  }

  _updateCursor() {
    if (this.spaceDown) {
      this.canvasEl.style.cursor = 'grab';
      return;
    }
    this.canvasEl.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
  }
}function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function resizeRect(origin, handle, wp) {
  let { x, y, w, h } = origin;
  const right = x + w;
  const bottom = y + h;

  if (handle.includes('w')) {
    x = Math.min(wp.x, right - MIN_SHAPE);
    w = right - x;
  }
  if (handle.includes('e')) {
    w = Math.max(MIN_SHAPE, wp.x - x);
  }
  if (handle.includes('n')) {
    y = Math.min(wp.y, bottom - MIN_SHAPE);
    h = bottom - y;
  }
  if (handle.includes('s')) {
    h = Math.max(MIN_SHAPE, wp.y - y);
  }

  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function measureTextBox(ctx, text, fontSize) {
  ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const lines = String(text).split('\n');
  let maxW = 0;
  for (const line of lines) {
    const width = ctx.measureText(line || ' ').width;
    if (width > maxW) maxW = width;
  }
  return {
    w: Math.max(20, Math.ceil(maxW) + 8),
    h: Math.max(fontSize, Math.ceil(lines.length * fontSize * 1.3)),
  };
}
