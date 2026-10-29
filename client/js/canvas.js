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
/** 导出 PNG 的画布上限：单边与总面积都留出余量，避免 toBlob 返回 null */
const MAX_EXPORT_SIDE = 8192;
const MAX_EXPORT_AREA = 64 * 1024 * 1024;

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

  /**
   * 把视野对到所有图形上（「适应内容」）。
   * 只在缩小时生效——把一个小矩形放大到铺满屏幕没有意义。
   * @returns {boolean} 画布上没有图形时返回 false
   */
  fitContent(padding = 72) {
    const flats = [];
    for (const shape of this.getShapes()) {
      const flat = this.viewOf(shape);
      if (!flat || flat.deleted || flat.w <= 0 || flat.h <= 0) continue;
      flats.push(flat);
    }
    if (!flats.length) return false;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const f of flats) {
      if (f.x < minX) minX = f.x;
      if (f.y < minY) minY = f.y;
      if (f.x + f.w > maxX) maxX = f.x + f.w;
      if (f.y + f.h > maxY) maxY = f.y + f.h;
    }

    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const availW = Math.max(1, this.width - padding * 2);
    const availH = Math.max(1, this.height - padding * 2);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(availW / bw, availH / bh, 1)),
    );

    this.viewport = {
      scale,
      x: (this.width - bw * scale) / 2 - minX * scale,
      y: (this.height - bh * scale) / 2 - minY * scale,
    };
    this.render();
    return true;
  }

  get zoomText() {
    return `${Math.round(this.viewport.scale * 100)}%`;
  }

  // ── 命中测试 ─────────────────────────────────────────────

  /** 应用拖动预览后的扁平视图 */
  viewOf(shape) {
    const base = flatten(shape);
    const preview = this.getPreview();
    const patch = preview && typeof preview.get === 'function' ? preview.get(shape.id) : null;
    if (!patch) return base;

    const flat = { ...base, ...patch };
    // 画笔的点是「相对左上角」的：宽高一变（缩放预览），点也要按同一比例缩放，
    // 否则拖动把手的过程中笔迹纹丝不动，松手才突然跳一下。
    // 若预览里已经带了 pts（工具层在算缩放时一并给了），以它为准。
    if (
      flat.type === 'pen' &&
      Array.isArray(base.pts) &&
      base.pts.length >= 4 &&
      !patch.pts &&
      (base.w !== flat.w || base.h !== flat.h)
    ) {
      flat.pts = scalePoints(base.pts, flat.w / (base.w || 1), flat.h / (base.h || 1));
    }
    return flat;
  }

  hitTest(worldPt) {
    const shapes = this.getShapes();
    const tolerance = 3 / this.viewport.scale;
    for (let i = shapes.length - 1; i >= 0; i -= 1) {
      const flat = this.viewOf(shapes[i]);
      if (flat.deleted) continue;
      if (flat.type === 'pen') {
        // 一笔的包围盒可能很大（比如一条对角线），先看盒再逐段量距离，
        // 否则点在对角线旁边的空白处也会把整笔选中
        if (this._hitPen(flat, worldPt, tolerance)) return shapes[i].id;
      } else if (flat.type === 'ellipse') {
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

  _hitPen(flat, pt, tolerance) {
    const pts = flat.pts;
    if (!Array.isArray(pts) || pts.length < 4) return false;
    const reach = Math.max(tolerance, (flat.strokeWidth || 2) / 2 + 2);
    if (
      pt.x < flat.x - reach ||
      pt.x > flat.x + flat.w + reach ||
      pt.y < flat.y - reach ||
      pt.y > flat.y + flat.h + reach
    ) {
      return false;
    }
    const limit = reach * reach;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = flat.x + pts[i];
      const ay = flat.y + pts[i + 1];
      const bx = flat.x + pts[i + 2];
      const by = flat.y + pts[i + 3];
      if (distToSegmentSq(pt.x, pt.y, ax, ay, bx, by) <= limit) return true;
    }
    return false;
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
    const scale = this.viewport.scale;

    // 缩得很小时把网格步长翻倍，否则点阵密度会涨到几十万个 fillRect
    let step = GRID_STEP * scale;
    while (step > 0 && step < 10) step *= 2;
    if (step <= 0) return;

    const offsetX = ((this.viewport.x % step) + step) % step;
    const offsetY = ((this.viewport.y % step) + step) % step;
    const cols = Math.ceil(this.width / step) + 1;
    const rows = Math.ceil(this.height / step) + 1;

    // 每 5 格一个稍重的点，给「拖远了」一个方向感；同一帧里按颜色批量画，
    // 避免逐点切换 fillStyle。
    const minor = [];
    const major = [];
    for (let i = 0; i < cols; i += 1) {
      const x = Math.round(offsetX + i * step);
      const worldX = (x - this.viewport.x) / scale;
      const majorX = Math.round(worldX / GRID_STEP) % 5 === 0;
      for (let j = 0; j < rows; j += 1) {
        const y = Math.round(offsetY + j * step);
        const worldY = (y - this.viewport.y) / scale;
        const majorY = Math.round(worldY / GRID_STEP) % 5 === 0;
        (majorX && majorY ? major : minor).push(x, y);
      }
    }

    ctx.fillStyle = '#e2e8f2';
    for (let k = 0; k < minor.length; k += 2) ctx.fillRect(minor[k], minor[k + 1], 1, 1);

    ctx.fillStyle = '#cbd5e5';
    for (let k = 0; k < major.length; k += 2) ctx.fillRect(major[k], major[k + 1], 2, 2);
  }

  _drawShape(flat) {
    if (!flat || flat.deleted) return;
    const { ctx } = this;
    const { x, y, w, h } = flat;
    // 一笔水平/垂直的线，包围盒有一个方向为 0，不能按「空图形」丢掉
    if (flat.type === 'pen') {
      this._drawPen(flat);
      return;
    }
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

  /**
   * 画笔笔迹。pts 是相对 (x, y) 的扁平数组，渲染时补回左上角偏移。
   * 只描边不填充——一笔没有「内部」可言。
   */
  _drawPen(flat) {
    const pts = flat.pts;
    if (!Array.isArray(pts) || pts.length < 4) return;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(flat.x + pts[0], flat.y + pts[1]);
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo(flat.x + pts[i], flat.y + pts[i + 1]);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, flat.strokeWidth || 2);
    ctx.strokeStyle = flat.stroke && flat.stroke !== 'transparent' ? flat.stroke : '#1f2933';
    ctx.stroke();
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

  /**
   * 把当前所有可见图形导出成一张 PNG。
   *
   * 复用 _drawShape 而不是另写一套绘制代码：导出图必须和屏幕上看到的一致，
   * 两套绘制逻辑迟早会走样。做法是临时把 this.ctx 换成离屏画布的上下文。
   *
   * @returns {Promise<Blob|null>} 画布为空时返回 null
   */
  toPNGBlob({ padding = 32, scale = 2 } = {}) {
    const flats = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const shape of this.getShapes()) {
      const flat = flatten(shape);
      if (flat.deleted) continue;
      const drawable =
        flat.type === 'pen' ? Array.isArray(flat.pts) && flat.pts.length >= 4 : flat.w > 0 && flat.h > 0;
      if (!drawable) continue;
      flats.push(flat);
      if (flat.x < minX) minX = flat.x;
      if (flat.y < minY) minY = flat.y;
      if (flat.x + flat.w > maxX) maxX = flat.x + flat.w;
      if (flat.y + flat.h > maxY) maxY = flat.y + flat.h;
    }
    if (!flats.length) return Promise.resolve(null);

    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const w0 = bw + padding * 2;
    const h0 = bh + padding * 2;
    // 浏览器对 canvas 的边长与总面积都有硬上限（Chrome 单边 16384、总面积约 2.6 亿像素）。
    // 图形散布很开时 2 倍图会直接超限，toBlob 回调给 null，
    // 上层只能误报「画布上还没有图形」。这里按上限反算倍率，宁可导出小一点，也不返回空。
    const limitScale = Math.min(
      MAX_EXPORT_SIDE / w0,
      MAX_EXPORT_SIDE / h0,
      Math.sqrt(MAX_EXPORT_AREA / (w0 * h0)),
    );
    const effectiveScale = Math.max(0.05, Math.min(scale, limitScale));

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.ceil(Math.min(MAX_EXPORT_SIDE, w0 * effectiveScale)));
    out.height = Math.max(1, Math.ceil(Math.min(MAX_EXPORT_SIDE, h0 * effectiveScale)));

    const offCtx = out.getContext('2d');
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, out.width, out.height);
    offCtx.scale(effectiveScale, effectiveScale);
    offCtx.translate(-minX + padding, -minY + padding);

    const prev = this.ctx;
    this.ctx = offCtx;
    try {
      for (const flat of flats) this._drawShape(flat);
    } finally {
      this.ctx = prev;
    }

    return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'));
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

/** 按比例缩放一组相对点（x 用 sx，y 用 sy），并取整——与服务端归一化口径一致 */
export function scalePoints(pts, sx, sy) {
  if (!Array.isArray(pts)) return [];
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = Math.round(pts[i] * sx);
    out[i + 1] = Math.round(pts[i + 1] * sy);
  }
  return out;
}

/** 点到线段的距离平方（画笔命中测试用，避免每段都开方） */
function distToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ddx = px - ax;
    const ddy = py - ay;
    return ddx * ddx + ddy * ddy;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}
