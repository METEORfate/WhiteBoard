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
  let room = rooms.get(roomId);
  if (room) return room;
  room = new Room(roomId, { store, bootEpoch: BOOT_EPOCH, config: CONFIG, log }).load();
  rooms.set(roomId, room);
  return room;
}

// ── HTTP ────────────────────────────────────────────────────────

const serveStatic = createStaticHandler({
  rootDir: ROOT_DIR,
  entry: CONFIG.entry,
  mounts: CONFIG.mounts,
});

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const body = JSON.stringify({ ok: true, bootEpoch: BOOT_EPOCH, rooms: rooms.size });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/stats') {
    const body = JSON.stringify(
      {
        bootEpoch: BOOT_EPOCH,
        connections: connections.size,
        rooms: [...rooms.values()].map((r) => r.statsView()),
      },
      null,
      2,
    );
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
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
  if (conn) setupConnection(conn);
});

function sendError(conn, code, message) {
  conn.send({ type: MSG.ERROR, code, message });
}

/** 令牌桶限流：防止单个连接刷爆服务端 */
function takeToken(conn) {
  const now = Date.now();
  const elapsed = Math.max(0, now - conn.bucket.last) / 1000;
  conn.bucket.tokens = Math.min(LIMITS.RATE_BURST, conn.bucket.tokens + elapsed * LIMITS.RATE_PER_SEC);
  conn.bucket.last = now;
  if (conn.bucket.tokens < 1) {
    conn.violations += 1;
    if (conn.violations >= LIMITS.MAX_PROTOCOL_VIOLATIONS) {
      conn.close(CLOSE_CODE.POLICY_VIOLATION, 'rate limit exceeded');
    }
    return false;
  }
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
  if (!takeToken(conn)) return;

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

  conn.clientId = msg.clientId;
  conn.name = sanitizeName(msg.name);
  conn.color = presenceColor(msg.clientId);
  conn.room = getRoom(msg.roomId);
  conn.room.join(conn);
  log('info', `${conn.name}(${conn.clientId.slice(0, 8)}) 加入房间 ${msg.roomId}`);
}

function handleOp(conn, msg) {
  if (!conn.room) return sendError(conn, 'NOT_READY', '尚未加入房间');

  const op = msg.op;
  const result = conn.room.applyOp(conn, op);

  if (!result.ok) {
    sendError(conn, result.code, result.message);
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
    for (const conn of connections) conn.close(CLOSE_CODE.GOING_AWAY, 'server shutdown');
    connections.clear();
    server.close(() => resolve());
    setTimeout(resolve, 500).unref?.();
  });
}

export { server, rooms, connections };

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
