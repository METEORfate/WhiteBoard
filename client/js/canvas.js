/**
 * 画布渲染层：DPR 适配、视口变换（平移/缩放）、图形绘制、命中测试、选中把手。
 *
 * 坐标系有两套：
 *   世界坐标（图形 x/y/w/h 存储的就是它）与屏幕坐标（CSS 像素）。
 *   所有鼠标事件先转成世界坐标再做命中测试，否则缩放后点击会偏移。
 */

import { flatten } from '../../shared/merge.js';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const HANDLE_SIZE = 8;
const HANDLE_HIT = 7;
const GRID_STEP = 24;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const CURSORS = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

export class Board {
  constructor(canvas, { getShapes, getPreview, getSelection, getDraft, getMarquee }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getShapes = getShapes;
    this.getPreview = getPreview || (() => null);
    this.getSelection = getSelection || (() => new Set());
    this.getDraft = getDraft || (() => null);
    this.getMarquee = getMarquee || (() => null);

    this.viewport = { x: 0, y: 0, scale: 1 };
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this._raf = null;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement || canvas);
    }
    this.resize();
  }

  resize() {
    const host = this.canvas.parentElement || this.canvas;
    const rect = host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.render();
  }

  // ── 坐标变换 ─────────────────────────────────────────────

  screenToWorld(pt) {
    return {
      x: (pt.x - this.viewport.x) / this.viewport.scale,
      y: (pt.y - this.viewport.y) / this.viewport.scale,
    };
  }

  worldToScreen(pt) {
    return {
      x: pt.x * this.viewport.scale + this.viewport.x,
      y: pt.y * this.viewport.scale + this.viewport.y,
    };
  }

  eventPoint(ev) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  zoomAt(screenPt, factor) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.viewport.scale * factor));
    if (next === this.viewport.scale) return;
    const world = this.screenToWorld(screenPt);
    this.viewport.scale = next;
    this.viewport.x = screenPt.x - world.x * next;
    this.viewport.y = screenPt.y - world.y * next;
    this.render();
  }

  panBy(dx, dy) {
    this.viewport.x += dx;
    this.viewport.y += dy;
    this.render();
  }

  resetView() {
    this.viewport = { x: 0, y: 0, scale: 1 };
    this.render();
  }

  get zoomText() {
    return `${Math.round(this.viewport.scale * 100)}%`;
  }

  // ── 命中测试 ─────────────────────────────────────────────

  /** 应用拖动预览后的扁平视图 */
  viewOf(shape) {
    const flat = flatten(shape);
    const preview = this.getPreview();
    const patch = preview && typeof preview.get === 'function' ? preview.get(shape.id) : null;
    if (patch) Object.assign(flat, patch);
    return flat;
  }

  hitTest(worldPt) {
    const shapes = this.getShapes();
    const tolerance = 3 / this.viewport.scale;
    for (let i = shapes.length - 1; i >= 0; i -= 1) {
      const flat = this.viewOf(shapes[i]);
      if (flat.deleted) continue;
      if (flat.type === 'ellipse') {
        const cx = flat.x + flat.w / 2;
        const cy = flat.y + flat.h / 2;
        const rx = flat.w / 2 + tolerance;
        const ry = flat.h / 2 + tolerance;
        if (rx <= 0 || ry <= 0) continue;
        const dx = (worldPt.x - cx) / rx;
        const dy = (worldPt.y - cy) / ry;
        if (dx * dx + dy * dy <= 1) return shapes[i].id;
      } else {
        if (
          worldPt.x >= flat.x - tolerance &&
          worldPt.x <= flat.x + flat.w + tolerance &&
          worldPt.y >= flat.y - tolerance &&
          worldPt.y <= flat.y + flat.h + tolerance
        ) {
          return shapes[i].id;
        }
      }
    }
    return null;
  }

  /** 单个选中图形的缩放把手命中（屏幕坐标） */
  handleAt(screenPt) {
    const selection = this.getSelection();
    if (selection.size !== 1) return null;
    const id = [...selection][0];
    const shape = this.getShapes().find((s) => s.id === id);
    if (!shape) return null;
    const flat = this.viewOf(shape);
    for (const name of HANDLES) {
      const p = this.worldToScreen(this.handlePoint(flat, name));
      if (Math.abs(screenPt.x - p.x) <= HANDLE_HIT && Math.abs(screenPt.y - p.y) <= HANDLE_HIT) {
        return name;
      }
    }
    return null;
  }

  handlePoint(flat, name) {
    const cx = flat.x + flat.w / 2;
    const cy = flat.y + flat.h / 2;
    switch (name) {
      case 'nw':
        return { x: flat.x, y: flat.y };
      case 'n':
        return { x: cx, y: flat.y };
      case 'ne':
        return { x: flat.x + flat.w, y: flat.y };
      case 'e':
        return { x: flat.x + flat.w, y: cy };
      case 'se':
        return { x: flat.x + flat.w, y: flat.y + flat.h };
      case 's':
        return { x: cx, y: flat.y + flat.h };
      case 'sw':
        return { x: flat.x, y: flat.y + flat.h };
      case 'w':
        return { x: flat.x, y: cy };
      default:
        return { x: cx, y: cy };
    }
  }

  static cursorFor(handle) {
    return CURSORS[handle] || 'default';
  }

  /** 框选：返回与矩形相交的图形 id */
  shapesInRect(rect) {
    const out = [];
    const x2 = rect.x + rect.w;
    const y2 = rect.y + rect.h;
    for (const shape of this.getShapes()) {
      const flat = flatten(shape);
      if (flat.deleted) continue;
      const overlap =
        flat.x < x2 && flat.x + flat.w > rect.x && flat.y < y2 && flat.y + flat.h > rect.y;
      if (overlap) out.push(shape.id);
    }
    return out;
  }

  // ── 渲染 ─────────────────────────────────────────────────

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._draw();
    });
  }

  _draw() {
    const { ctx, dpr } = this;
    const w = this.width;
    const h = this.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    this._drawGrid();

    ctx.save();
    ctx.translate(this.viewport.x, this.viewport.y);
    ctx.scale(this.viewport.scale, this.viewport.scale);

    for (const shape of this.getShapes()) {
      this._drawShape(this.viewOf(shape));
    }

    const draft = this.getDraft();
    if (draft) this._drawShape({ ...draft, fill: draft.fill || 'rgba(37,99,235,0.08)', stroke: '#2563eb' });

    ctx.restore();

    this._drawSelection();
    this._drawMarquee();
  }

  _drawGrid() {
    const { ctx } = this;
    const step = GRID_STEP * this.viewport.scale;
    if (step < 9) return;

    const offsetX = ((this.viewport.x % step) + step) % step;
    const offsetY = ((this.viewport.y % step) + step) % step;

    ctx.fillStyle = '#d7dee9';
    for (let x = offsetX; x < this.width; x += step) {
      for (let y = offsetY; y < this.height; y += step) {
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
  }

  _drawShape(flat) {
    if (!flat || flat.deleted) return;
    const { ctx } = this;
    const { x, y, w, h } = flat;
    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.lineJoin = 'round';

    if (flat.type === 'rect') {
      this._roundRect(x, y, w, h, Math.min(10, Math.min(w, h) * 0.12));
      this._fillAndStroke(flat);
    } else if (flat.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
      this._fillAndStroke(flat);
    } else if (flat.type === 'text') {
      this._drawText(flat);
    }

    ctx.restore();
  }

  _fillAndStroke(flat) {
    const { ctx } = this;
    if (flat.fill && flat.fill !== 'transparent') {
      ctx.fillStyle = flat.fill;
      ctx.fill();
    }
    if (flat.strokeWidth > 0 && flat.stroke) {
      ctx.lineWidth = flat.strokeWidth;
      ctx.strokeStyle = flat.stroke;
      ctx.stroke();
    }
  }

  _drawText(flat) {
    const { ctx } = this;
    const size = flat.fontSize || 20;
    const lines = String(flat.text || '').split('\n');
    const lineHeight = size * 1.3;
    ctx.font = `500 ${size}px ${FONT_STACK}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = flat.fill === 'transparent' ? '#0f172a' : flat.fill;
    lines.forEach((line, i) => {
      ctx.fillText(line, flat.x, flat.y + i * lineHeight);
    });
    if (flat.strokeWidth > 0 && flat.stroke && flat.stroke !== 'transparent' && lines.some((l) => l)) {
      // 文本描边仅用于占位框，避免"看不见的文本"
    }
  }

  _roundRect(x, y, w, h, r) {
    const { ctx } = this;
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  _drawSelection() {
    const selection = this.getSelection();
    if (!selection.size) return;
    const { ctx } = this;
    const shapes = this.getShapes();

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#2563eb';
    ctx.setLineDash([4, 4]);

    for (const shape of shapes) {
      if (!selection.has(shape.id)) continue;
      const flat = this.viewOf(shape);
      const a = this.worldToScreen({ x: flat.x, y: flat.y });
      const b = this.worldToScreen({ x: flat.x + flat.w, y: flat.y + flat.h });
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    }

    ctx.setLineDash([]);
    if (selection.size === 1) {
      const shape = shapes.find((s) => s.id === [...selection][0]);
      if (shape) {
        const flat = this.viewOf(shape);
        for (const name of HANDLES) {
          const p = this.worldToScreen(this.handlePoint(flat, name));
          const half = HANDLE_SIZE / 2;
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.rect(Math.round(p.x - half) + 0.5, Math.round(p.y - half) + 0.5, HANDLE_SIZE, HANDLE_SIZE);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  _drawMarquee() {
    const marquee = this.getMarquee();
    if (!marquee) return;
    const { ctx } = this;
    const a = this.worldToScreen({ x: marquee.x, y: marquee.y });
    const b = this.worldToScreen({ x: marquee.x + marquee.w, y: marquee.y + marquee.h });
    ctx.save();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)';
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    ctx.restore();
  }

  /** 文本图形的屏幕包围盒（用于定位内联编辑器） */
  screenRectOf(id) {
    const shape = this.getShapes().find((s) => s.id === id);
    if (!shape) return null;
    const flat = this.viewOf(shape);
    const a = this.worldToScreen({ x: flat.x, y: flat.y });
    return {
      left: a.x,
      top: a.y,
      width: Math.max(40, flat.w * this.viewport.scale),
      height: Math.max(24, flat.h * this.viewport.scale),
      fontSize: (flat.fontSize || 20) * this.viewport.scale,
      flat,
    };
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this._ro?.disconnect();
  }
}
