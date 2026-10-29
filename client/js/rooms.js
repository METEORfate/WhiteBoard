/**
 * 房间号相关的纯函数：生成、整理、解析、探测、最近记录。
 *
 * 放在独立文件里是因为 main.js 只负责装配，UI 只负责 DOM——
 * 「用户输入的房间名怎么变成一个合法房间号」这条规则两边都要用，
 * 散着写迟早会分叉。
 */

import { canonicalRoomId, isValidRoomId } from '../../shared/protocol.js';

/**
 * 房间号字符表：去掉了 l / o / 0 / 1。
 * 房间号经常要靠嘴念、手抄（「你进 room k3f9 那个」），
 * 形近字符是这类场景下最常见的事故来源。
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const RANDOM_LEN = 8;
const RECENT_KEY = 'wb:recent';
const RECENT_MAX = 6;

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
    return bytes;
  }
  // 非安全上下文（http://内网IP）下个别浏览器没有 crypto.getRandomValues。
  // 房间号只是「不好猜」，不承担加密职责，退化到 Math.random 可接受。
  for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** 生成一个随机房间号：8 位，约 32^8 ≈ 1.1e12 种可能 */
export function randomRoomId() {
  const bytes = randomBytes(RANDOM_LEN);
  let s = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/**
 * 把用户输入整理成合法房间号。
 *
 * 协议只允许 `[A-Za-z0-9_-]`，所以中文、空格、标点都会被剥掉。
 * 全被剥掉时返回空串，由调用方改成随机房间号——
 * 绝不能静默回落到某个公共房间：
 * 用户以为自己建了新房，实际上正对着别人画过的白板。
 *
 * @param {string} raw
 * @returns {string} 合法房间号，或空串
 */
export function slugRoomName(raw) {
  const input = String(raw || '');
  // 有没有被剥掉过东西：用来判断残渣能不能代表用户的意思
  const hadNonAscii = /[^\x20-\x7e]/.test(input);

  const s = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, 48);

  if (!isValidRoomId(s)) return '';

  // 中文被剥掉后剩下的碎片往往毫无意义：「我的白板 2026」→「2026」。
  // 这种残渣既容易和别人的房间撞号，也和用户以为的房间名对不上，不采用。
  if (hadNonAscii && (s.length < 3 || !/[a-z]/.test(s))) return '';

  return s;
}

/** 输入是否「被改动过」（用于提示用户房间号已规范化） */
export function isDirtySlug(raw, slug) {
  return canonicalRoomId(raw) !== slug;
}

/**
 * 解析「加入房间」输入框：既接受房间号，也接受整条邀请链接。
 *
 * 用户从聊天软件里复制过来的东西通常带着前后空格、中文标点，
 * 甚至只有链接里的一小段。这里按「链接 → 房间号 → 规范化」三段兜底，
 * 能救回来就救，救不回来返回 null 让界面报错，不猜。
 *
 * @param {string} raw
 * @returns {{roomId: string, fromLink: boolean}|null}
 */
export function parseRoomInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // 1) 完整链接或带 ?room= 的片段
  if (/^(https?:)?\/\//i.test(text) || text.includes('?') || text.includes('room=')) {
    try {
      const url = new URL(text, location.href);
      const fromQuery = canonicalRoomId(url.searchParams.get('room') || '');
      if (isValidRoomId(fromQuery)) return { roomId: fromQuery, fromLink: true };
      // 没有 query 时，允许「链接最后一段就是房间号」这种手改过的形式
      const last = canonicalRoomId(url.pathname.split('/').filter(Boolean).pop() || '');
      if (isValidRoomId(last) && last !== 'index.html') return { roomId: last, fromLink: true };
    } catch {
      /* 不是合法 URL，继续按房间号处理 */
    }
  }

  // 2) 直接是房间号（大小写不敏感）
  const direct = canonicalRoomId(text);
  if (isValidRoomId(direct)) return { roomId: direct, fromLink: false };

  // 3) 带空格/中文标点的房间号，尽量整理
  const slug = slugRoomName(text);
  if (slug) return { roomId: slug, fromLink: false };

  return null;
}

/**
 * 探测房间是否存在。失败一律当作「不知道」，不要让网络问题挡住用户进房。
 * @param {string} roomId
 * @returns {Promise<{exists:boolean, members:number, shapes:number|null}|null>}
 */
export async function probeRoom(roomId) {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      exists: Boolean(data.exists),
      members: Number(data.members) || 0,
      shapes: typeof data.shapes === 'number' ? data.shapes : null,
    };
  } catch {
    return null;
  }
}

/** 服务端是否在线（落地页顶部那颗状态灯） */
export async function probeServer() {
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 带房间号的分享链接 */
export function roomUrl(roomId) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomId);
  url.hash = '';
  return url.toString();
}

/** 直接进入某个房间（整页跳转，让 Net / Store 在新房间上重新装配） */
export function enterRoom(roomId) {
  location.href = roomUrl(roomId);
}

// ── 最近打开的房间 ─────────────────────────────────────────────
//
// 存在 localStorage 而不是服务端：服务端不记「谁来过哪个房间」，
// 房间号即凭证的设计不该被一份访问日志破坏。

/**
 * @returns {Array<{id: string, at: number, name?: string}>}
 */
export function loadRecentRooms() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && isValidRoomId(canonicalRoomId(r.id)))
      .map((r) => ({
        id: canonicalRoomId(r.id),
        at: Number(r.at) || 0,
        name: typeof r.name === 'string' ? r.name : '',
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 记录一次进入（同房间去重并提到最前） */
export function rememberRoom(roomId, name = '') {
  const id = canonicalRoomId(roomId);
  if (!isValidRoomId(id)) return;
  const rest = loadRecentRooms().filter((r) => r.id !== id);
  const next = [{ id, at: Date.now(), name }, ...rest].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下写不进去，不影响进房 */
  }
}

export function forgetRooms() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* ignore */
  }
}

// ── 昵称 ──────────────────────────────────────────────────────
//
// 不提供自定义昵称输入：这个项目里昵称只用来在成员列表和远端光标上区分人，
// 生成一个「访客-xxxx」足够，少一个必填项就少一层进房摩擦。

const NAME_KEY = 'wb:name';

/** 读昵称；没有就生成一个「访客-xxxx」，保证房间成员列表里认得出人 */
export function loadName(fallbackSeed = '') {
  let name = '';
  try {
    name = localStorage.getItem(NAME_KEY) || '';
  } catch {
    /* ignore */
  }
  if (name.trim()) return name.trim().slice(0, 20);
  const tail = String(fallbackSeed).replace(/^c-/, '').slice(0, 4) || Math.random().toString(36).slice(2, 6);
  return `访客-${tail}`;
}

/** 「3 分钟前」这类相对时间，用于最近房间列表 */
export function timeAgo(ts) {
  const diff = Date.now() - (Number(ts) || 0);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(Number(ts)).toLocaleDateString('zh-CN');
}
