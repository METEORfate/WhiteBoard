/**
 * 服务入口：静态资源 + WebSocket 房间服务。
 *
 * 启动：node server/index.js
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { CONFIG, ROOT_DIR } from './config.js';
import { Room } from './room.js';
import { createStaticHandler } from './static.js';
import { Store } from './store.js';
import { CLOSE_CODE, acceptUpgrade } from './ws.js';
import { shortId } from '../shared/ids.js';
import {
  LIMITS,
  MSG,
  canonicalRoomId,
  isValidClientId,
  isValidEpoch,
  isValidRoomId,
  presenceColor,
  sanitizeName,
} from '../shared/protocol.js';

/** 每次进程启动都换一个 epoch，客户端据此判断「服务端重启过，必须全量重拉」 */
export const BOOT_EPOCH = `${Date.now().toString(36)}-${shortId(6)}`;

const store = new Store(CONFIG.dataDir);
/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Set<import('./ws.js').WSConnection>} */
const connections = new Set();
let connSeq = 0;

const LEVEL_TAG = { info: 'INFO', warn: 'WARN', error: 'ERR ' };
const QUIET = process.env.WB_QUIET === '1';

export function log(level, message) {
  if (QUIET && level !== 'error') return;
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`${stamp} ${LEVEL_TAG[level] || 'INFO'} ${message}`);
}

function getRoom(roomId) {
  const id = canonicalRoomId(roomId);
  let room = rooms.get(id);
  if (room) return room;
  room = new Room(id, { store, bootEpoch: BOOT_EPOCH, config: CONFIG, log }).load();
  rooms.set(id, room);
  return room;
}

/** 房间是否已存在：内存里有，或者磁盘上有日志（进程重启后内存是空的） */
function hasRoom(roomId) {
  const id = canonicalRoomId(roomId);
  return rooms.has(id) || store.has(id);
}

// ── 建房配额 ────────────────────────────────────────────────────
//
// 单房间时代不需要这些；一旦访客能自己建房，「建一万个空房间」就是最省力的
// 一种 DoS：每个 Room 都常驻内存，每个房间还各写一个 jsonl。
// 两道闸：全局房间数上限 + 单 IP 每小时建房次数。
// 进已有房间不受限——分享链接本来就是给很多人点的。

/** ip → 最近一小时内建房的时间戳（滑动窗口） */
const createLog = new Map();
const CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 检查建房配额，通过则记账。
 * @param {{ip?: string}} conn
 * @returns {{code: string, message: string}|null} null 表示放行
 */
export function checkCreateQuota(conn) {
  if (rooms.size >= CONFIG.maxRooms) {
    return { code: 'ROOM_LIMIT', message: `服务端房间数已达上限 ${CONFIG.maxRooms}，请稍后再试` };
  }

  const ip = (conn && conn.ip) || 'unknown';
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (recent.length >= CONFIG.roomCreatePerHour) {
    createLog.set(ip, recent);
    return {
      code: 'ROOM_RATE_LIMITED',
      message: `创建房间过于频繁（每小时上限 ${CONFIG.roomCreatePerHour} 个），请稍后再试`,
    };
  }
  recent.push(now);
  createLog.set(ip, recent);
  return null;
}

/** 探测接口的每 IP 令牌桶，防止拿它当房间号枚举器 */
const probeBuckets = new Map();
function takeProbeToken(ip) {
  const now = Date.now();
  const b = probeBuckets.get(ip) || { tokens: CONFIG.roomProbePerMin, last: now };
  b.tokens = Math.min(
    CONFIG.roomProbePerMin,
    b.tokens + ((now - b.last) / 60000) * CONFIG.roomProbePerMin,
  );
  b.last = now;
  probeBuckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  // IPv4 走 IPv6 映射时去掉前缀，否则 ::ffff:127.0.0.1 与 127.0.0.1 会算成两个人
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ── HTTP ────────────────────────────────────────────────────────

const serveStatic = createStaticHandler({
  rootDir: ROOT_DIR,
  entry: CONFIG.entry,
  mounts: CONFIG.mounts,
});

const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  const pathname = (req.url || '/').split('?')[0];

  if (pathname === '/healthz') {
    const body = JSON.stringify({ ok: true, bootEpoch: BOOT_EPOCH, rooms: rooms.size });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }

  if (pathname === '/api/stats') {
    // 房间清单会把「有哪些房间、各有多少人」全部暴露出去，等于绕过「房间号即凭证」。
    // 生产环境的反向代理也可能从回环地址连接，不能将它当成本机运维请求。
    // 生产环境禁用统计接口；本地开发仍只对回环地址开放。
    if (process.env.NODE_ENV === 'production' || !isLoopback(ip)) {
      sendJson(res, 403, { error: 'FORBIDDEN', message: '房间统计仅限本机访问' });
      return;
    }
    sendJson(res, 200, {
      bootEpoch: BOOT_EPOCH,
      connections: connections.size,
      rooms: [...rooms.values()].map((r) => r.statsView()),
    });
    return;
  }

  if (pathname.startsWith('/api/rooms/')) {
    // 存在性探测：给「加入房间」输入框做即时反馈，避免打错一个字就静默建了个空房间。
    // 只回答「在不在 / 几个人 / 多少个图形」，不返回任何图形内容。
    if (!takeProbeToken(ip)) {
      sendJson(res, 429, { error: 'RATE_LIMITED', message: '探测过于频繁' });
      return;
    }
    let raw;
    try {
      raw = decodeURIComponent(pathname.slice('/api/rooms/'.length));
    } catch {
      sendJson(res, 400, { error: 'BAD_ROOM_ID', message: 'roomId 编码非法' });
      return;
    }
    if (!isValidRoomId(raw)) {
      sendJson(res, 400, { error: 'BAD_ROOM_ID', message: 'roomId 非法' });
      return;
    }
    const roomId = canonicalRoomId(raw);
    const live = rooms.get(roomId);
    const exists = Boolean(live) || store.has(roomId);
    sendJson(res, 200, {
      roomId,
      exists,
      // 房间没加载时不去 load 它——探一下就把整个日志读进内存，等于给探测接口开了个放大器
      members: live ? live.members.size : 0,
      shapes: live ? live.statsView().alive : null,
    });
    return;
  }

  if (serveStatic(req, res)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// ── WebSocket ───────────────────────────────────────────────────

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    /* ignore */
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const conn = acceptUpgrade(req, socket, head, {
    requireMask: true,
    sendMasked: false,
    maxPayload: LIMITS.MAX_FRAME_BYTES,
  });
  if (conn) {
    conn.ip = clientIp(req);
    setupConnection(conn);
    // 监听器装配完成后再处理握手包里多出来的字节：
    // 客户端若把首帧和 Upgrade 请求写在同一个 write 里，这里才不会丢消息。
    conn.feed(head);
  }
});

function sendError(conn, code, message, extra) {
  conn.send({ type: MSG.ERROR, code, message, ...(extra || {}) });
}

/**
 * 令牌桶限流：防止单个连接刷爆服务端。
 *
 * 注意：取不到令牌**不算协议违规**，否则客户端一次大批量重放就会被踢掉；
 * 违规只统计「发错东西」（坏 JSON、非法消息），见 handleMessage。
 */
function takeToken(conn) {
  const now = Date.now();
  const elapsed = Math.max(0, now - conn.bucket.last) / 1000;
  conn.bucket.tokens = Math.min(LIMITS.RATE_BURST, conn.bucket.tokens + elapsed * LIMITS.RATE_PER_SEC);
  conn.bucket.last = now;
  if (conn.bucket.tokens < 1) return false;
  conn.bucket.tokens -= 1;
  return true;
}

function setupConnection(conn) {
  conn.id = `conn-${(connSeq += 1)}`;
  conn.clientId = null;
  conn.name = null;
  conn.color = null;
  conn.room = null;
  conn.joined = false;
  conn.pending = null;
  conn.violations = 0;
  conn.rateHits = 0;
  conn.bucket = { tokens: LIMITS.RATE_BURST, last: Date.now() };
  connections.add(conn);

  const helloTimer = setTimeout(() => {
    if (!conn.room) conn.close(CLOSE_CODE.POLICY_VIOLATION, 'hello timeout');
  }, CONFIG.helloTimeoutMs);
  helloTimer.unref?.();

  conn.on('message', (text) => {
    try {
      handleMessage(conn, text);
    } catch (err) {
      log('error', `处理消息异常：${err && err.stack ? err.stack : err}`);
      sendError(conn, 'INTERNAL', '服务端处理失败');
    }
  });

  conn.on('protocol-error', (code, reason) => {
    log('warn', `连接 ${conn.id} 协议错误 ${code}：${reason}`);
  });

  conn.on('close', () => {
    clearTimeout(helloTimer);
    connections.delete(conn);
    if (conn.room) conn.room.leave(conn);
  });
}

function handleMessage(conn, text) {
  if (!takeToken(conn)) {
    // 限流必须有回执：静默丢弃会让客户端永远不知道自己那条 op 没发出去，
    // 于是它既不重试也不报错，待发队列永远清不空。
    conn.rateHits = (conn.rateHits || 0) + 1;
    if (conn.rateHits > 600) conn.close(CLOSE_CODE.POLICY_VIOLATION, 'rate limit exceeded');
    sendError(conn, 'RATE_LIMITED', '发送过快，请退避后重试');
    return;
  }
  conn.rateHits = 0;

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    sendError(conn, 'BAD_JSON', '消息不是合法 JSON');
    conn.violations += 1;
    if (conn.violations >= LIMITS.MAX_PROTOCOL_VIOLATIONS) {
      conn.close(CLOSE_CODE.POLICY_VIOLATION, 'too many invalid messages');
    }
    return;
  }

  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    sendError(conn, 'BAD_MESSAGE', '缺少 type');
    return;
  }

  switch (msg.type) {
    case MSG.HELLO:
      return handleHello(conn, msg);

    case MSG.OP:
      return handleOp(conn, msg);

    case MSG.PRESENCE: {
      if (!conn.room) return sendError(conn, 'NOT_READY', '尚未加入房间');
      conn.room.updatePresence(conn, msg.cursor);
      return undefined;
    }

    case MSG.PING:
      return conn.send({ type: MSG.PONG, t: msg.t, serverSeq: conn.room ? conn.room.serverSeq : 0 });

    default:
      sendError(conn, 'UNKNOWN_TYPE', `未知消息类型 ${msg.type}`);
      return undefined;
  }
}

function handleHello(conn, msg) {
  if (conn.room) {
    // 重复 hello：忽略，保持原房间绑定
    conn.send({
      type: MSG.WELCOME,
      roomId: conn.room.id,
      bootEpoch: BOOT_EPOCH,
      serverSeq: conn.room.serverSeq,
      shapes: conn.room.snapshot().shapes,
      members: conn.room.memberList(),
      duplicateHello: true,
    });
    return;
  }

  if (!isValidRoomId(msg.roomId)) return sendError(conn, 'BAD_ROOM_ID', 'roomId 非法');
  if (!isValidClientId(msg.clientId)) return sendError(conn, 'BAD_CLIENT_ID', 'clientId 非法');
  if (!isValidEpoch(msg.sessionEpoch)) return sendError(conn, 'BAD_EPOCH', 'sessionEpoch 非法');

  const roomId = canonicalRoomId(msg.roomId);

  // 只有「真的要新建一个房间」才消耗配额；进已有房间不设限，否则分享链接发给
  // 一群人时，第二个人开始就会被拦下。
  if (!hasRoom(roomId)) {
    const denied = checkCreateQuota(conn);
    if (denied) {
      log('warn', `拒绝 ${conn.ip || '?'} 创建房间 ${roomId}：${denied.code}`);
      return sendError(conn, denied.code, denied.message);
    }
  }

  conn.clientId = msg.clientId;
  conn.name = sanitizeName(msg.name);
  conn.color = presenceColor(msg.clientId);
  conn.room = getRoom(roomId);
  conn.room.join(conn);
  log('info', `${conn.name}(${conn.clientId.slice(0, 8)}) 加入房间 ${roomId}`);
}

function handleOp(conn, msg) {
  if (!conn.room) return sendError(conn, 'NOT_READY', '尚未加入房间');

  const op = msg.op;
  const result = conn.room.applyOp(conn, op);

  if (!result.ok) {
    // 带上 opId，客户端才知道该把哪条 op 从待发队列里摘掉
    sendError(conn, result.code, result.message, { opId: (op && op.opId) || null });
    if (result.resync) {
      conn.send({ type: MSG.RESYNC, reason: result.code });
    }
    return undefined;
  }

  conn.send({
    type: MSG.ACK,
    opId: (op && op.opId) || null,
    accepted: result.accepted,
    duplicate: result.duplicate,
    seq: result.seq,
    shape: result.shape,
  });
  return undefined;
}

// ── 死连接清扫 ──────────────────────────────────────────────────

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const conn of connections) {
    if (now - conn.lastSeen > CONFIG.idleTimeoutMs) {
      log('warn', `连接 ${conn.id} 空闲超时，主动断开`);
      conn.close(CLOSE_CODE.GOING_AWAY, 'idle timeout');
    }
  }
}, 20_000);
sweeper.unref?.();

// ── 空房间回收 ──────────────────────────────────────────────────
//
// 房间是「第一次有人进来」时懒创建的，之后没人会主动删。单房间时这无所谓，
// 但访客能自由建房之后，内存里的 Room 会随房间数线性增长。
// 这里只卸载内存：磁盘上的 jsonl 保留，下次有人进来重新 load，数据不丢。

/**
 * 回收空闲房间。
 * @param {{now?: number, ttlMs?: number}} [opts] 测试里直接传 now/ttlMs，不必等真实时间
 * @returns {number} 卸载的房间数
 */
export function reapRooms({ now = Date.now(), ttlMs = CONFIG.roomIdleTtlMs } = {}) {
  let dropped = 0;
  for (const [id, room] of rooms) {
    if (!room.isIdle(now, ttlMs)) continue;
    rooms.delete(id);
    dropped += 1;
  }

  // 顺手清理配额记账：窗口外的 IP 记录留着只会让 Map 无限长大
  for (const [ip, list] of createLog) {
    if (!list.length || now - list[list.length - 1] >= CREATE_WINDOW_MS) createLog.delete(ip);
  }
  for (const [ip, b] of probeBuckets) {
    if (now - b.last > 10 * 60 * 1000) probeBuckets.delete(ip);
  }

  if (dropped > 0) log('info', `回收 ${dropped} 个空闲房间（磁盘数据保留，再次进入会自动加载）`);
  return dropped;
}

const reaper = setInterval(() => reapRooms(), 60_000);
reaper.unref?.();

// ── 启停 ────────────────────────────────────────────────────────

/** 端口被占用时最多往后顺延几个（8787 → 8788 …）。设 STRICT_PORT=1 可关闭顺延 */
const PORT_FALLBACK_ATTEMPTS = 10;

/** 运行期错误只记日志——再让它变成 unhandled 'error' 就又把进程打挂了 */
let runtimeErrorBound = false;
function onRuntimeError(err) {
  log('error', `服务端运行异常：${err.message}`);
}

/**
 * 启动 HTTP 服务。
 *
 * 端口被占用时默认自动顺延（8787 → 8788 …），因为「端口冲突」是最常见的启动失败原因，
 * 而它几乎总是「上次的实例没关干净」，让用户自己去查 PID 属于把内部细节推给使用者。
 * 需要固定端口（部署 / CI / 反向代理）时设 STRICT_PORT=1，冲突即失败退出。
 *
 * @param {number} port 0 表示交给系统分配（不存在冲突，因此不参与顺延）
 * @returns {Promise<number>} 实际监听端口
 */
export function start(port = CONFIG.port) {
  const strict = process.env.STRICT_PORT === '1';
  const maxTries = strict || port === 0 ? 1 : PORT_FALLBACK_ATTEMPTS;

  return new Promise((resolve, reject) => {
    let candidate = port;
    let tries = 0;

    const onListenError = (err) => {
      tries += 1;
      if (err.code === 'EADDRINUSE' && tries < maxTries) {
        const next = candidate + 1;
        log('warn', `端口 ${candidate} 已被占用，改用 ${next}`);
        candidate = next;
        // listen 失败后 server 不会停留在 listening 态，可以继续用同一个实例重试
        server.listen(candidate, CONFIG.host);
        return;
      }
      server.removeListener('error', onListenError);
      err.attempted = { from: port, to: candidate, tries };
      reject(err);
    };

    server.on('error', onListenError);
    server.once('listening', () => {
      server.removeListener('error', onListenError);
      if (!runtimeErrorBound) {
        server.on('error', onRuntimeError);
        runtimeErrorBound = true;
      }
      const actual = server.address().port;
      log('info', `白板服务已启动 http://localhost:${actual}  (bootEpoch=${BOOT_EPOCH})`);
      log('info', `数据目录：${CONFIG.dataDir}`);
      resolve(actual);
    });

    server.listen(candidate, CONFIG.host);
  });
}

/** 启动失败时的可操作提示。走 console.error，避免 WB_QUIET=1 时被吞掉 */
function printPortHelp({ from, to, tries }) {
  const range = tries > 1 ? `${from}～${to}` : String(from);
  const lines = [
    '',
    `✗ 端口 ${range} 已被占用，服务启动失败`,
    '',
    '  任选一种方式解决：',
    '',
    '  1) 结束占用端口的进程（PowerShell）',
    `     Get-NetTCPConnection -LocalPort ${from} -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`,
    '',
    '  2) 换一个端口',
    '     PowerShell:  $env:PORT=9000; node server/index.js',
    '     Bash:        PORT=9000 node server/index.js',
    '',
    '  3) 让系统分配空闲端口',
    '     PowerShell:  $env:PORT=0; node server/index.js',
    '',
    '  说明：默认会自动往后顺延 10 个端口，全部占用才会走到这里；',
    '        设 STRICT_PORT=1 可关闭顺延，冲突即退出。',
    '',
  ];
  console.error(lines.join('\n'));
}

export function stop() {
  return new Promise((resolve) => {
    clearInterval(sweeper);
    clearInterval(reaper);
    for (const conn of connections) conn.close(CLOSE_CODE.GOING_AWAY, 'server shutdown');
    connections.clear();
    server.close(() => resolve());
    setTimeout(resolve, 500).unref?.();
  });
}

export { server, rooms, connections, store };

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start().catch((err) => {
    if (err.code === 'EADDRINUSE') {
      printPortHelp(err.attempted || { from: CONFIG.port, to: CONFIG.port, tries: 1 });
    } else if (err.code === 'EACCES') {
      const p = (err.attempted && err.attempted.from) ?? CONFIG.port;
      console.error(
        `\n✗ 没有权限绑定端口 ${p}：1024 以下的端口需要管理员权限，换一个高位端口即可\n` +
          `   PowerShell:  $env:PORT=8787; node server/index.js\n`,
      );
    } else {
      log('error', `启动失败：${err.message}`);
    }
    process.exit(1);
  });

  const shutdown = () => {
    log('info', '正在关闭服务…');
    stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
