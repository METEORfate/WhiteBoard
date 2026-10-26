/**
 * 共享协议层：消息类型、字段规格、归一化与校验。
 *
 * 浏览器与 Node 引入的是同一份文件，这保证了「客户端乐观应用」与
 * 「服务端权威归一化」使用的是完全相同的 clamp / 取整 / 校验规则。
 * 一旦两侧规则不一致，服务端归一化后的值就会和客户端本地值永久分叉。
 */

export const PROTOCOL_VERSION = 1;

export const MSG = Object.freeze({
  HELLO: 'hello',
  WELCOME: 'welcome',
  OP: 'op',
  ACK: 'ack',
  PRESENCE: 'presence',
  RESYNC: 'resync',
  ERROR: 'error',
  // 浏览器 WebSocket API 不允许应用层发送控制帧，心跳只能走应用层消息
  PING: 'ping',
  PONG: 'pong',
});

export const OP_KIND = Object.freeze({
  CREATE: 'create',
  PATCH: 'patch',
  DELETE: 'delete',
});

export const LIMITS = Object.freeze({
  MAX_FRAME_BYTES: 64 * 1024,
  MAX_COORD: 100000,
  MAX_SIZE: 20000,
  MIN_SIZE: 2,
  MAX_STROKE_WIDTH: 64,
  MIN_FONT_SIZE: 6,
  MAX_FONT_SIZE: 400,
  MAX_TEXT_LEN: 2000,
  MAX_SHAPES_PER_ROOM: 5000,
  MAX_PATCH_FIELDS: 12,
  MAX_ROOM_ID_LEN: 64,
  MAX_NAME_LEN: 32,
  MAX_QUEUE: 5000,
  RATE_PER_SEC: 60,
  RATE_BURST: 120,
  MAX_PROTOCOL_VIOLATIONS: 20,
});

export const SHAPE_TYPES = Object.freeze(['rect', 'ellipse', 'text']);

/**
 * 每个可同步字段的规格。
 * 图形的每个字段都是一个独立的 LWW-Register（见 merge.js）。
 */
export const FIELD_SPEC = Object.freeze({
  x: { type: 'number', min: -LIMITS.MAX_COORD, max: LIMITS.MAX_COORD, def: 0, integer: true },
  y: { type: 'number', min: -LIMITS.MAX_COORD, max: LIMITS.MAX_COORD, def: 0, integer: true },
  w: { type: 'number', min: LIMITS.MIN_SIZE, max: LIMITS.MAX_SIZE, def: 160, integer: true },
  h: { type: 'number', min: LIMITS.MIN_SIZE, max: LIMITS.MAX_SIZE, def: 120, integer: true },
  fill: { type: 'color', def: '#ffffff' },
  stroke: { type: 'color', def: '#1f2933' },
  strokeWidth: { type: 'number', min: 0, max: LIMITS.MAX_STROKE_WIDTH, def: 2, integer: true },
  text: { type: 'string', maxLen: LIMITS.MAX_TEXT_LEN, def: '' },
  fontSize: { type: 'number', min: LIMITS.MIN_FONT_SIZE, max: LIMITS.MAX_FONT_SIZE, def: 20, integer: true },
  /** 层叠顺序：新建图形用时间戳当 z，保证各端渲染层级一致 */
  z: { type: 'number', min: 0, max: 1e15, def: 0, integer: true },
  deleted: { type: 'boolean', def: false },
});

export const PATCH_FIELDS = Object.freeze(Object.keys(FIELD_SPEC));

/** 创建图形时必须带齐的几何字段，避免产生「不可见图形」 */
export const REQUIRED_ON_CREATE = Object.freeze(['x', 'y', 'w', 'h']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID_RE = /^[a-z0-9-]{6,40}$/;
const EPOCH_RE = /^[a-z0-9-]{4,40}$/;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
const TRANSPARENT = 'transparent';

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function isValidRoomId(v) {
  return typeof v === 'string' && ROOM_ID_RE.test(v);
}

export function isValidClientId(v) {
  return typeof v === 'string' && CLIENT_ID_RE.test(v);
}

export function isValidEpoch(v) {
  return typeof v === 'string' && EPOCH_RE.test(v);
}

function fail(code, message) {
  return { ok: false, code, message };
}

function ok(value) {
  return { ok: true, value };
}

/**
 * 归一化单个字段值。
 * 数值越界走 clamp（不是拒绝）——因为 clamp 是幂等的，两端执行结果必然一致；
 * 而 NaN / Infinity / 非法颜色 / 超长文本属于「无法可靠解释」的输入，直接拒绝。
 */
export function normalizeField(name, raw) {
  const spec = FIELD_SPEC[name];
  if (!spec) return fail('UNKNOWN_FIELD', `未知字段 ${name}`);

  if (spec.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return fail('BAD_NUMBER', `字段 ${name} 必须是有限数字`);
    }
    let v = raw;
    if (spec.integer) v = Math.round(v);
    if (v < spec.min) v = spec.min;
    if (v > spec.max) v = spec.max;
    return ok(v);
  }

  if (spec.type === 'color') {
    if (typeof raw !== 'string') return fail('BAD_COLOR', `字段 ${name} 必须是字符串`);
    const v = raw.trim().toLowerCase();
    if (v === TRANSPARENT) return ok(v);
    if (!COLOR_RE.test(v)) return fail('BAD_COLOR', `字段 ${name} 颜色格式非法`);
    return ok(v);
  }

  if (spec.type === 'string') {
    if (typeof raw !== 'string') return fail('BAD_STRING', `字段 ${name} 必须是字符串`);
    // 按码点计数，避免 emoji 被算成两个字符
    if ([...raw].length > spec.maxLen) {
      return fail('STRING_TOO_LONG', `字段 ${name} 超过 ${spec.maxLen} 字符`);
    }
    return ok(raw);
  }

  if (spec.type === 'boolean') {
    if (typeof raw !== 'boolean') return fail('BAD_BOOLEAN', `字段 ${name} 必须是布尔值`);
    return ok(raw);
  }

  return fail('BAD_SPEC', `字段 ${name} 规格未定义`);
}

export function normalizePatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('BAD_PATCH', 'patch 必须是对象');
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) return fail('EMPTY_PATCH', 'patch 不能为空');
  if (keys.length > LIMITS.MAX_PATCH_FIELDS) {
    return fail('PATCH_TOO_LARGE', `patch 字段数超过 ${LIMITS.MAX_PATCH_FIELDS}`);
  }
  const out = {};
  for (const key of keys) {
    const r = normalizeField(key, raw[key]);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return ok(out);
}

/**
 * 校验并归一化一条 op。只保留白名单字段，防止脏数据进入文档。
 * @param {unknown} raw
 * @returns {{ok:true, op:object} | {ok:false, code:string, message:string}}
 */
export function normalizeOp(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('NOT_OBJECT', 'op 必须是对象');
  }

  const opId = typeof raw.opId === 'string' ? raw.opId.toLowerCase() : '';
  if (!isUuid(opId)) return fail('BAD_OP_ID', 'opId 必须是 uuid');

  if (!isValidRoomId(raw.roomId)) return fail('BAD_ROOM_ID', 'roomId 非法');
  if (!isValidClientId(raw.clientId)) return fail('BAD_CLIENT_ID', 'clientId 非法');
  if (!isValidEpoch(raw.sessionEpoch)) return fail('BAD_EPOCH', 'sessionEpoch 非法');

  const clientSeq = raw.clientSeq;
  if (!Number.isInteger(clientSeq) || clientSeq < 1 || clientSeq > 1e12) {
    return fail('BAD_CLIENT_SEQ', 'clientSeq 必须是正整数');
  }

  const ver = raw.ver;
  if (!Number.isInteger(ver) || ver < 1 || ver > 1e9) {
    return fail('BAD_VERSION', 'ver 必须是 1..1e9 的整数');
  }

  const target = typeof raw.target === 'string' ? raw.target.toLowerCase() : '';
  if (!isUuid(target)) return fail('BAD_TARGET', 'target 必须是 uuid');

  const kind = raw.kind;
  if (kind !== OP_KIND.CREATE && kind !== OP_KIND.PATCH && kind !== OP_KIND.DELETE) {
    return fail('BAD_KIND', 'kind 非法');
  }

  const patchRes = normalizePatch(raw.patch);
  if (!patchRes.ok) return patchRes;
  const patch = patchRes.value;

  let shapeType;
  if (kind === OP_KIND.CREATE) {
    if (!SHAPE_TYPES.includes(raw.shapeType)) {
      return fail('BAD_SHAPE_TYPE', 'shapeType 非法');
    }
    shapeType = raw.shapeType;
    for (const f of REQUIRED_ON_CREATE) {
      if (!(f in patch)) return fail('MISSING_GEOMETRY', `create 缺少字段 ${f}`);
    }
    // 新建图形一定不是墓碑
    patch.deleted = false;
  }

  if (kind === OP_KIND.DELETE) {
    patch.deleted = true;
  }

  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now();

  return {
    ok: true,
    op: {
      opId,
    roomId: raw.roomId,
    clientId: raw.clientId,
    sessionEpoch: raw.sessionEpoch,
    clientSeq,
    kind,
    target,
    shapeType,
    ver,
    patch,
    ts,
    },
  };
}

/**
 * 校验一个「带戳的图形」——用于快照与广播帧。
 * 客户端同样要对远端数据做这一步：不信任服务端，也不信任其他客户端。
 */
export function normalizeShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('BAD_SHAPE', 'shape 必须是对象');
  }
  const id = typeof raw.id === 'string' ? raw.id.toLowerCase() : '';
  if (!isUuid(id)) return fail('BAD_SHAPE_ID', 'shape.id 必须是 uuid');
  if (!SHAPE_TYPES.includes(raw.type)) return fail('BAD_SHAPE_TYPE', 'shape.type 非法');
  if (!raw.fields || typeof raw.fields !== 'object' || Array.isArray(raw.fields)) {
    return fail('BAD_FIELDS', 'shape.fields 必须是对象');
  }

  const fields = {};
  for (const [name, cell] of Object.entries(raw.fields)) {
    if (!FIELD_SPEC[name]) return fail('UNKNOWN_FIELD', `未知字段 ${name}`);
    if (!cell || typeof cell !== 'object') return fail('BAD_CELL', `字段 ${name} 缺少戳`);
    const v = cell.v;
    if (!Number.isInteger(v) || v < 1 || v > 1e9) return fail('BAD_CELL_VERSION', `字段 ${name} 版本非法`);
    if (!isValidClientId(cell.c)) return fail('BAD_CELL_CLIENT', `字段 ${name} clientId 非法`);
    if (!isUuid(cell.o)) return fail('BAD_CELL_OP', `字段 ${name} opId 非法`);
    const r = normalizeField(name, cell.val);
    if (!r.ok) return r;
    fields[name] = { val: r.value, v, c: cell.c, o: cell.o.toLowerCase() };
  }

  return { ok: true, shape: { id, type: raw.type, fields } };
}

/** 清理用户昵称：去掉控制字符、限长、给个默认值 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '访客';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return '访客';
  return [...cleaned].slice(0, LIMITS.MAX_NAME_LEN).join('');
}

/** 由 clientId 派生一个稳定的展示色（仅用于光标，不进入文档字段） */
export function presenceColor(clientId) {
  let h = 0;
  for (let i = 0; i < clientId.length; i += 1) {
    h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 72% 46%)`;
}
