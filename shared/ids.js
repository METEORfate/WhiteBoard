/**
 * 标识符生成（浏览器与 Node 共用）。
 *
 * 注意：`crypto.randomUUID()` 只在安全上下文（https / localhost）下可用。
 * 局域网 http 访问时它是 undefined，因此必须提供 getRandomValues 兜底，
 * 否则 opId 生成失败会直接让整个同步链路崩掉。
 */

const HEX = '0123456789abcdef';

export function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** RFC4122 v4 UUID */
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = [];
  for (let i = 0; i < 16; i += 1) h.push(b[i].toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/** 短随机串（用于 clientId、sessionEpoch 等非安全场景） */
export function shortId(len = 10) {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += HEX[b[i] & 0x0f];
  return s;
}

/**
 * 会话 epoch：每次页面加载重新生成。
 * 服务端按 (clientId, sessionEpoch) 维护 clientSeq 高水位，
 * 这样「清空本地缓存后 clientSeq 归 1」不会被误判成重复投递。
 */
export function newSessionEpoch() {
  return `${Date.now().toString(36)}-${shortId(6)}`;
}
