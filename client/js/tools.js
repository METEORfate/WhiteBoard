/**
 * 交互控制：工具状态机 + 指针事件处理。
 *
 * 拖动/缩放期间的做法：
 *   鼠标移动时只更新「预览」（画布直接画出来，手感是零延迟的），
 *   每 60ms 才把当前几何提交成一条 op；松开时补一次最终提交。
 *   这样既有即时反馈，又不会因为一次拖动产生几百条 op。
 *   撤销记录在拖动结束时合并成一条，避免用户按一次 Ctrl+Z 只退回 1 像素。
 */

import { Board, scalePoints } from './canvas.js';
import { LIMITS } from '../../shared/protocol.js';

const COMMIT_INTERVAL = 60;
const MIN_SHAPE = 4;
const DEFAULT_W = 160;
const DEFAULT_H = 110;
const MIN_DRAG = 3;
/** 画笔采样间隔（世界坐标像素）：太密会让一笔上千个点，太疏会看出折线 */
const PEN_MIN_DIST = 2;
/** 连续粘贴的偏移量，避免第二份完全盖住第一份 */
const PASTE_OFFSET = 20;
/** 会写进「新建图形默认样式」的字段；位置/尺寸/层级不在此列 */
const STYLE_KEYS = new Set(['fill', 'stroke', 'strokeWidth', 'fontSize', 'textColor']);

/** 字段值比较：pts 是数组，引用比较永远为 false */
function fieldEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

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
    /** 复制缓冲区：存的是扁平视图快照，粘贴时据此重新生成 op */
    this.clipboard = [];

    this.style = {
      fill: '#dbeafe',
      stroke: '#1e293b',
      strokeWidth: 2,
      fontSize: 20,
      textColor: '#0f172a',
    };

    this._lastCommit = 0;
    this._editorState = null;
    /** 输入法组合状态：中文选词时按回车是「上屏」，不能当成「提交文本」 */
    this._composing = false;
    this._compositionEndAt = 0;
    /** 样式事务：滑杆拖动期间记录调整前的快照，松手时合并成一条撤销 */
    this._styleBefore = null;
    this._styleKeys = null;
    this._styleTimer = null;
    /** 当前正在处理的那根手指/鼠标。多指触控时后来的指针一律忽略 */
    this._activePointer = null;
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
      // 输入法正在组词时，回车用于「上屏候选词」、Esc 用于「取消组词」，
      // 都不该被当成编辑器自己的快捷键。Chrome 会带 isComposing，
      // Safari 的部分版本只在 keyCode 上体现（229），两个都判。
      // 另外部分浏览器在 compositionend 之后才派发那次 Enter，补一个 100ms 窗口。
      const justComposed = Date.now() - this._compositionEndAt < 100;
      if (this._composing || e.isComposing || e.keyCode === 229 || justComposed) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeTextEditor(true);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._commitText();
      }
      e.stopPropagation();
    });
    this.editor.addEventListener('compositionstart', () => {
      this._composing = true;
    });
    this.editor.addEventListener('compositionend', () => {
      this._composing = false;
      this._compositionEndAt = Date.now();
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
    // 整批只登记一条撤销：逐个 deleteShape 会各 push 一条，
    // 框选 3 个按 Delete 后 Ctrl+Z 只能回来 1 个。
    this.store.deleteShapes([...this.selection]);
    this.selection.clear();
    this.ui?.updateSelection();
    this.board.render();
  }

  /**
   * 复制选中图形到内存剪贴板。
   * 复制的是**扁平视图快照**而不是 op：粘贴要生成全新的 id 与版本号，
   * 直接重放旧 op 会撞到「同一 opId 内容不同」的幂等检查上。
   */
  copySelection() {
    const items = [];
    for (const id of this.selection) {
      const flat = this.store.flat(id);
      if (!flat || flat.deleted) continue;
      items.push(flat);
    }
    if (!items.length) {
      this.ui?.toast('先选中图形再复制', 'warn');
      return false;
    }
    this.clipboard = items;
    this.ui?.toast(`已复制 ${items.length} 个图形`);
    return true;
  }

  /** 粘贴：每个图形生成一条新的 create op，整体偏移一点避免完全重叠 */
  paste() {
    if (!this.clipboard.length) {
      this.ui?.toast('剪贴板是空的', 'warn');
      return false;
    }
    // 整批只登记一条撤销：逐个 createShape 的话，粘贴 3 个后 Ctrl+Z 只删掉 1 个
    const specs = this.clipboard.map((src) => ({
      type: src.type,
      x: Math.round((src.x || 0) + PASTE_OFFSET),
      y: Math.round((src.y || 0) + PASTE_OFFSET),
      w: src.w,
      h: src.h,
      fill: src.fill,
      stroke: src.stroke,
      strokeWidth: src.strokeWidth,
      text: src.text,
      fontSize: src.fontSize,
      ...(Array.isArray(src.pts) && src.pts.length ? { pts: src.pts.slice() } : {}),
    }));
    const ids = this.store.createShapes(specs, { label: `粘贴 ${specs.length} 个图形` }).map((c) => c.id);
    // 连续按 Ctrl+V 要一次比一次更偏，否则第二份会严丝合缝盖住第一份
    this.clipboard = this.clipboard.map((s) => ({
      ...s,
      x: (s.x || 0) + PASTE_OFFSET,
      y: (s.y || 0) + PASTE_OFFSET,
    }));
    this.selection = new Set(ids);
    this.ui?.updateSelection();
    this.ui?.refresh();
    this.board.render();
    this.ui?.toast(`已粘贴 ${ids.length} 个图形`);
    return true;
  }

  /**
   * 修改选中图形的样式。
   *
   * 处于「样式事务」中时（滑杆正在拖）只应用不记撤销，整段拖动由
   * endStyleEdit 合并成一条；否则每个图形各记一条，Ctrl+Z 要按十几次。
   */
  applyStyleToSelection(patch) {
    // 只把真正的样式字段写进「新建图形的默认样式」。
    // 位置/尺寸/层级也走这个方法，但它们不该成为新图形的默认值。
    for (const key of Object.keys(patch)) {
      if (STYLE_KEYS.has(key)) this.style[key] = patch[key];
    }
    if (!this.selection.size) return;

    const inTransaction = Boolean(this._styleBefore);
    const items = [];
    for (const id of this.selection) {
      const before = this.store.flat(id);
      if (!before) continue;
      // 事务开始之后才被选中的图形不在 _styleBefore 里，单独记一条，
      // 否则它的改动会被吞掉、Ctrl+Z 撤不回来
      const captured = inTransaction && this._styleBefore.has(id);
      this.store.applyLocal(id, { ...patch }, { record: false });
      if (captured) {
        for (const key of Object.keys(patch)) this._styleKeys.add(key);
      } else {
        const back = {};
        for (const key of Object.keys(patch)) back[key] = before[key];
        items.push({
          id,
          forward: { kind: 'patch', patch: { ...patch } },
          backward: { kind: 'patch', patch: back },
        });
      }
    }
    if (inTransaction) this._restartStyleTimer();
    if (items.length) this.store.recordUndo({ label: '修改样式', items });
    this.board.render();
  }

  /** 开始一段连续的样式调整（拖动滑杆 / 连续取色），记录调整前的快照 */
  beginStyleEdit() {
    if (!this.selection.size) return;
    if (this._styleBefore) {
      this._restartStyleTimer();
      return;
    }
    this._styleBefore = new Map();
    this._styleKeys = new Set();
    for (const id of this.selection) {
      const flat = this.store.flat(id);
      if (flat) this._styleBefore.set(id, flat);
    }
    this._restartStyleTimer();
  }

  /** 结束样式调整：把整段变化合并成一条撤销记录 */
  endStyleEdit(label = '修改样式') {
    clearTimeout(this._styleTimer);
    this._styleTimer = null;
    const before = this._styleBefore;
    const keys = this._styleKeys ? [...this._styleKeys] : [];
    this._styleBefore = null;
    this._styleKeys = null;
    if (!before || !before.size || !keys.length) return;

    const items = [];
    for (const [id, old] of before) {
      const flat = this.store.flat(id);
      if (!flat) continue;
      const fwd = {};
      const back = {};
      let changed = false;
      for (const key of keys) {
        fwd[key] = flat[key];
        back[key] = old[key];
        if (!fieldEqual(fwd[key], back[key])) changed = true;
      }
      if (changed) {
        items.push({
          id,
          forward: { kind: 'patch', patch: fwd },
          backward: { kind: 'patch', patch: back },
        });
      }
    }
    if (items.length) this.store.recordUndo({ label, items });
  }

  /** 用户松手却始终没触发 change 时，靠空闲计时兜底结束事务 */
  _restartStyleTimer() {
    clearTimeout(this._styleTimer);
    this._styleTimer = setTimeout(() => this.endStyleEdit(), 800);
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
    // 多指触控：只认第一根手指。否则第二根手指按下会覆盖 this.drag，
    // 任意一根抬起就结束拖拽，图形会跳到另一根手指的位置。
    if (e.pointerId !== undefined) {
      if (this._activePointer !== null && this._activePointer !== e.pointerId) return;
      this._activePointer = e.pointerId;
    }
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
      // startScreen 用来判定「到底有没有拖」：draft 里的宽高已经被 clamp 到
      // MIN_SHAPE，拿它跟 MIN_DRAG 比是恒真的，单击会得到一个 4×4 的隐形图形。
      this.drag = { mode: 'create', start: wp, startScreen: sp, moved: false };
      this.draft = this._draftFor(this.tool, wp, wp);
      this.board.render();
      return;
    }

    if (this.tool === 'text') {
      this._openTextEditor({ world: wp, fontSize: this.style.fontSize });
      return;
    }

    if (this.tool === 'pen') {
      this.drag = { mode: 'draw', points: [wp] };
      this.draft = this._penDraft(this.drag.points);
      this.board.render();
    }
  }

  _onPointerMove(e) {
    if (e.pointerId !== undefined && this._activePointer !== null && e.pointerId !== this._activePointer) {
      return;
    }
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
      if (this.drag.startScreen) {
        const dx = sp.x - this.drag.startScreen.x;
        const dy = sp.y - this.drag.startScreen.y;
        if (dx * dx + dy * dy >= MIN_DRAG * MIN_DRAG) this.drag.moved = true;
      }
      this.draft = this._draftFor(this.drag.type || this.tool, this.drag.start, wp, e.shiftKey);
      this.board.render();
      return;
    }

    if (this.drag.mode === 'draw') {
      const points = this.drag.points;
      const last = points[points.length - 1];
      const dx = wp.x - last.x;
      const dy = wp.y - last.y;
      // 采样间隔 + 点数上限：既控制 payload，也控制渲染成本
      if (dx * dx + dy * dy < PEN_MIN_DIST * PEN_MIN_DIST) return;
      if (points.length >= LIMITS.MAX_POINTS) return;
      points.push(wp);
      this.draft = this._penDraft(points);
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
      const patch = { ...rect };
      // 文本按高度比例同步字号：只改包围盒的话，拉大之后文字还是原来那么小，
      // 再双击编辑一次 measureTextBox 又会把宽高缩回去。
      if (this.drag.originType === 'text' && this.drag.origin.h > 0) {
        const scaled = Math.round(this.drag.originFontSize * (rect.h / this.drag.origin.h));
        patch.fontSize = Math.min(LIMITS.MAX_FONT_SIZE, Math.max(LIMITS.MIN_FONT_SIZE, scaled));
      }
      // 画笔的缩放要连点一起缩：否则包围盒变了、笔迹没变，对端看到的还是原样
      const originPts = this.drag.originPts;
      if (Array.isArray(originPts) && originPts.length >= 4) {
        patch.pts = scalePoints(
          originPts,
          rect.w / (this.drag.origin.w || 1),
          rect.h / (this.drag.origin.h || 1),
        );
      }
      this.preview.set(this.drag.id, patch);
      this.board.render();
      this._throttleCommit();
    }
  }

  _onPointerUp(e) {
    if (e.pointerId !== undefined && this._activePointer !== null && e.pointerId !== this._activePointer) {
      return;
    }
    this._activePointer = null;
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

    if (mode === 'draw') {
      const points = this.drag.points;
      this.draft = null;
      this.drag = null;
      // 只点了一下没有拖动：不生成图形（一个点画不出线，留着只会成为「看不见的图形」）
      if (points.length >= 2) {
        const draft = this._penDraft(points);
        const { id } = this.store.createShape({ ...draft });
        this.selection = new Set([id]);
        this.ui?.updateSelection();
        this.ui?.refresh();
      }
      this.board.render();
      return;
    }

    if (mode === 'create') {
      const drag = this.drag;
      const draft = this.draft;
      this.draft = null;
      this.drag = null;
      if (draft) {
        // 没拖动过（单击）：按默认尺寸在点击处居中放一个图形；
        // 拖过：用拖动出来的矩形。判定必须用「屏幕位移」，不能用 clamp 后的宽高。
        const dragged = drag?.moved === true;
        const w = dragged ? draft.w : DEFAULT_W;
        const h = dragged ? draft.h : DEFAULT_H;
        const x = dragged ? draft.x : draft.x - w / 2;
        const y = dragged ? draft.y : draft.y - h / 2;
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

      if (drag.originsFlat) {
        // 拖动过程中的中间 op 不单独记撤销，这里合并成一条。
        // 不依赖 drag.moved：它在 60ms 节流的 _throttleCommit 里才置位，
        // 60ms 内完成的缩放会「改了几何却没有撤销记录」。
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
            if (!fieldEqual(fwd[key], back[key])) changed = true;
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
    if (meta && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      this.copySelection();
      return;
    }
    if (meta && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      this.paste();
      return;
    }
    if (meta && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (this.copySelection()) this.paste();
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
      case 'p':
      case 'P':
        this.setTool('pen');
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
    const origin = { x: flat.x, y: flat.y, w: flat.w, h: flat.h };
    // 撤销要能连字号/笔迹一起还原，所以它们也必须进 originsFlat
    const undoOrigin = { ...origin };
    if (flat.type === 'text') undoOrigin.fontSize = flat.fontSize;
    if (flat.type === 'pen' && Array.isArray(flat.pts) && flat.pts.length) {
      undoOrigin.pts = flat.pts.slice();
    }
    this.drag = {
      mode: 'resize',
      id,
      handle,
      start: wp,
      origin,
      // 文本缩放要同步字号，否则拉大包围盒后文字还是原来那么大，
      // 再双击编辑一次 measureTextBox 又会把宽高缩回去，缩放等于白做
      originType: flat.type,
      originFontSize: flat.fontSize,
      originPts: flat.type === 'pen' && Array.isArray(flat.pts) ? flat.pts.slice() : null,
      originsFlat: { [id]: undoOrigin },
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
    // 先落上一处还没提交的编辑。
    // blur() 是同步触发的：这样 mousedown 的默认行为随后不会再触发一次 blur，
    // 也就不会用「新编辑器」的状态去提交旧内容（那会把刚输入的字整段丢掉）。
    if (this._editorState) {
      if (document.activeElement === this.editor) this.editor.blur();
      else this._commitText();
    }
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

  /**
   * 由一串世界坐标点生成画笔草稿：
   * 包围盒取 min/max，点转成「相对左上角」的扁平数组（与协议里的 pts 同构）。
   */
  _penDraft(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const x = Math.round(minX);
    const y = Math.round(minY);
    const pts = [];
    for (const p of points) pts.push(Math.round(p.x - x), Math.round(p.y - y));
    return {
      type: 'pen',
      x,
      y,
      w: Math.max(2, Math.round(maxX - minX)),
      h: Math.max(2, Math.round(maxY - minY)),
      pts,
      fill: 'transparent',
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
}

function normalizeRect(x1, y1, x2, y2) {
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
