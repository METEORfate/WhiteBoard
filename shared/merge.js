/**
 * 字段级 LWW-Register 合并（浏览器与 Node 共用）。
 *
 * 数据模型：图形的每个字段都是一个独立的 LWW-Register，
 * 携带全序戳 (v = version, c = clientId, o = opId)。
 *
 * 为什么是「字段级」而不是「整图形级」：
 *   A 改颜色、B 同时移动时，整图形级 LWW 会让戳大的一方整条覆盖，
 *   另一方的操作凭空消失。字段级合并让两个操作都保留，
 *   这也是白板上最容易被现场发现的"看起来像 bug"的场景。
 *
 * 收敛性：mergeField 对同一字段取戳最大者，即逐字段 max 运算。
 *   max 满足交换律、结合律、幂等性 → 合并结果与消息到达顺序无关，
 *   重复投递无副作用 → 所有副本收到相同消息集合后必然收敛到同一状态。
 */
 
import { FIELD_SPEC, PATCH_FIELDS } from './protocol.js';

/** 全序戳比较：v → c → o 字典序。任意两个戳都有确定顺序。 */
export function cmpStamp(a, b) {
  if (a.v !== b.v) return a.v < b.v ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  if (a.o !== b.o) return a.o < b.o ? -1 : 1;
  return 0;
}

export function makeStamp(ver, clientId, opId) {
  return { v: ver, c: clientId, o: opId };
}

/** 图形内出现过的最大版本号（客户端据此计算下一个 ver） */
export function maxVersion(shape) {
  if (!shape) return 0;
  let max = 0;
  for (const cell of Object.values(shape.fields)) {
    if (cell.v > max) max = cell.v;
  }
  return max;
}

export function cloneShape(shape) {
  const fields = {};
  for (const [name, cell] of Object.entries(shape.fields)) {
    fields[name] = { val: cell.val, v: cell.v, c: cell.c, o: cell.o };
  }
  return { id: shape.id, type: shape.type, fields };
}

/** 空图形：只有 id 与 type，所有字段缺失时由 flatten 补默认值 */
export function emptyShape(id, type) {
  return { id, type, fields: {} };
}

/** 扁平视图：渲染与命中测试只认这个，与网络结构解耦 */
export function flatten(shape) {
  const out = { id: shape.id, type: shape.type };
  for (const name of PATCH_FIELDS) {
    const cell = shape.fields[name];
    if (cell === undefined) {
      // 数组类型的默认值不能直接引用 FIELD_SPEC 里那一份，否则任何一次
      // 就地修改都会污染全局默认值（pts 就是这种情况）
      out[name] = Array.isArray(FIELD_SPEC[name].def) ? [] : FIELD_SPEC[name].def;
    } else {
      out[name] = Array.isArray(cell.val) ? cell.val.slice() : cell.val;
    }
  }
  return out;
}

export function isVisible(shape) {
  if (!shape) return false;
  const cell = shape.fields.deleted;
  return cell === undefined ? true : cell.val !== true;
}

/**
 * 把一组字段写进图形（生成候选状态，不修改入参）。
 * 同一 op 的所有字段共享同一个戳。
 */
export function applyPatch(shape, patch, stamp) {
  const next = shape ? cloneShape(shape) : emptyShape(stamp.target, stamp.type);
  if (stamp.type) next.type = stamp.type;
  for (const [name, val] of Object.entries(patch)) {
    if (!FIELD_SPEC[name]) continue; // 白名单外的字段直接忽略
    next.fields[name] = { val, v: stamp.v, c: stamp.c, o: stamp.o };
  }
  return next;
}

/**
 * 单字段合并。
 * @param {object|undefined} local
 * @param {object|undefined} remote
 * @param {{authoritative?: boolean}} opts
 *        authoritative=true 表示 remote 来自服务端（序列化点）：
 *        戳相等时采用远端值，用来吸收服务端的归一化结果（clamp / 取整）。
 */
export function mergeField(local, remote, opts = {}) {
  if (!local) return remote ? { ...remote } : local;
  if (!remote) return { ...local };
  const cmp = cmpStamp(remote, local);
  if (cmp > 0) return { ...remote };
  if (cmp === 0 && opts.authoritative) return { ...remote };
  return { ...local };
}

/** 逐字段合并两个图形副本 */
export function mergeShape(local, remote, opts = {}) {
  if (!local) return cloneShape(remote);
  if (!remote) return cloneShape(local);
  if (local.id !== remote.id) {
    throw new Error(`mergeShape: id 不一致 ${local.id} vs ${remote.id}`);
  }
  const next = { id: local.id, type: local.type || remote.type, fields: {} };
  const names = new Set([...Object.keys(local.fields), ...Object.keys(remote.fields)]);
  for (const name of names) {
    const merged = mergeField(local.fields[name], remote.fields[name], opts);
    if (merged) next.fields[name] = merged;
  }
  return next;
}

/** 应用一条 op 得到候选图形，再与当前状态合并（保证幂等 + 抗乱序） */
export function mergeOp(shape, op, opts = {}) {
  const stamp = { v: op.ver, c: op.clientId, o: op.opId, target: op.target, type: op.shapeType };
  const candidate = applyPatch(shape, op.patch, stamp);
  return mergeShape(shape, candidate, opts);
}

/** 结构化相等（字段顺序无关），用于判断服务端是否真的发生了状态变更 */
export function shapesEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.id !== b.id || a.type !== b.type) return false;
  const ka = Object.keys(a.fields).sort();
  const kb = Object.keys(b.fields).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    const x = a.fields[ka[i]];
    const y = b.fields[kb[i]];
    if (x.v !== y.v || x.c !== y.c || x.o !== y.o) return false;
    // 画笔的 pts 是数组：引用比较永远为 false，会让服务端误判「状态变了」
    if (Array.isArray(x.val) || Array.isArray(y.val)) {
      if (JSON.stringify(x.val) !== JSON.stringify(y.val)) return false;
    } else if (x.val !== y.val) {
      return false;
    }
  }
  return true;
}

/** 把图形压缩成可比较的字符串指纹（服务端用于校验 opId 冲突） */
export function opFingerprint(op) {
  const keys = Object.keys(op.patch).sort();
  const parts = keys.map((k) => `${k}=${JSON.stringify(op.patch[k])}`);
  return `${op.kind}|${op.target}|${op.shapeType || ''}|${op.ver}|${parts.join(',')}`;
}
