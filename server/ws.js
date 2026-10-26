/**
 * 极简 RFC6455 WebSocket 实现（服务端 + 测试用客户端）。
 *
 * 为什么手写：题目要求"说明通信协议、消息格式和异常处理方式"。
 * 手写后协议细节不再是黑盒，而且整个项目零 npm 依赖，
 * 评卷方 clone 下来 `node server/index.js` 就能跑，不需要 npm install。
 *
 * 覆盖的协议要点：
 *   - 握手：Sec-WebSocket-Key + SHA1(GUID) → Sec-WebSocket-Accept
 *   - 帧头：FIN / RSV / opcode / MASK / 7·16·64 位长度
 *   - 客户端帧必须带掩码，服务端帧不带（RFC6455 §5.1）
 *   - 分片（continuation frame）重组
 *   - 控制帧（close / ping / pong），控制帧不可分片且载荷 ≤125
 *   - 文本帧严格 UTF-8 校验，非法编码用 1007 关闭
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

// RFC6455 §1.3 的握手魔数。
// 注意最后一段是 C5AB0DC85B11，不是 5AB0DC85B11F —— 写错也能"自洽"地跑通
// 自己写的客户端，但任何真实浏览器都会直接拒绝握手。tests/ws.test.js 用
// RFC 官方的 key/accept 向量把这个常量钉死。
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Sec-WebSocket-Accept = base64(sha1(key + GUID)) */
export function computeAccept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export const OPCODE = Object.freeze({
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export const CLOSE_CODE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
});

const EMPTY = Buffer.alloc(0);

function closePayload(code, reason) {
  const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
  const buf = Buffer.alloc(2 + r.length);
  buf.writeUInt16BE(code, 0);
  r.copy(buf, 2);
  return buf;
}

/**
 * 一帧的编码。masked=true 用于客户端 → 服务端方向。
 */
export function encodeFrame(opcode, payload, { masked = false, fin = true } = {}) {
  const len = payload.length;
  let header;
  const maskBit = masked ? 0x80 : 0x00;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;

  if (!masked) return Buffer.concat([header, payload]);

  const mask = randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export class WSConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{requireMask?: boolean, sendMasked?: boolean, maxPayload?: number}} opts
   */
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.requireMask = opts.requireMask !== false;
    this.sendMasked = opts.sendMasked === true;
    this.maxPayload = opts.maxPayload ?? 64 * 1024;

    this.buffer = EMPTY;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentSize = 0;
    this.closed = false;
    this.closeEmitted = false;
    this.lastSeen = Date.now();
    this.lastPong = Date.now();
    this.bytesIn = 0;
    this.bytesOut = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => {
      this.emit('socket-error', err);
      this.#emitClose(1006, err.message);
    });
    socket.on('close', () => this.#emitClose(1006, 'socket closed'));
    socket.on('end', () => this.#emitClose(1000, 'peer ended'));
  }

  get isOpen() {
    return !this.closed && !this.socket.destroyed;
  }

  #emitClose(code, reason) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closed = true;
    this.emit('close', code, reason);
  }

  /** 协议错误：回一个 close 帧再断开，绝不静默丢弃 */
  #fail(code, reason) {
    if (this.closed) return;
    this.emit('protocol-error', code, reason);
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code, reason)));
    } catch {
      /* socket 已坏，忽略 */
    }
    this.closed = true;
    this.socket.end();
    this.#emitClose(code, reason);
  }

  #onData(chunk) {
    this.lastSeen = Date.now();
    this.bytesIn += chunk.length;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.#parse();
  }

  /** 供 upgrade 时处理 head 缓冲 */
  feed(chunk) {
    if (chunk && chunk.length) this.#onData(chunk);
  }

  #parse() {
    for (;;) {
      const buf = this.buffer;
      if (this.closed || buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, 'RSV 位必须为 0');

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) {
          return this.#fail(CLOSE_CODE.MESSAGE_TOO_BIG, '帧超出上限');
        }
        len = Number(big);
        offset = 10;
      }

      if (len > this.maxPayload) {
        return this.#fail(CLOSE_CODE.MESSAGE_TOO_BIG, `帧超出 ${this.maxPayload} 字节`);
      }
      if (this.requireMask && !masked) {
        return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '客户端帧必须掩码');
      }

      const isControl = (opcode & 0x08) !== 0;
      if (isControl && (len > 125 || !fin)) {
        return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '控制帧不可分片且载荷 ≤125');
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + len) return; // 半包，等更多数据

      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        const mask = buf.subarray(maskOffset, maskOffset + 4);
        const copy = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ mask[i & 3];
        payload = copy;
      }

      this.buffer = buf.subarray(offset + len);
      this.#handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  #handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_CODE.NORMAL;
        if (!this.closed) {
          try {
            this.socket.write(encodeFrame(OPCODE.CLOSE, closePayload(CLOSE_CODE.NORMAL, '')));
          } catch {
            /* ignore */
          }
          this.closed = true;
          this.socket.end();
        }
        this.#emitClose(code, 'peer close');
        return;
      }
      case OPCODE.PING: {
        this.#write(OPCODE.PONG, payload);
        this.emit('ping');
        return;
      }
      case OPCODE.PONG: {
        this.lastPong = Date.now();
        this.emit('pong');
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.CONT: {
        if (opcode === OPCODE.TEXT && this.fragments.length > 0) {
          return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '分片未结束又来新消息');
        }
        if (opcode === OPCODE.CONT && this.fragments.length === 0) {
          return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, '孤立的 continuation 帧');
        }
        if (opcode === OPCODE.TEXT) this.fragmentOpcode = OPCODE.TEXT;
        this.fragmentSize += payload.length;
        if (this.fragmentSize > this.maxPayload) {
          return this.#fail(CLOSE_CODE.MESSAGE_TOO_BIG, '分片消息总长超限');
        }
        this.fragments.push(payload);
        if (!fin) return;

        const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentSize = 0;

        let text;
        try {
          text = decoder.decode(full);
        } catch {
          return this.#fail(CLOSE_CODE.INVALID_PAYLOAD, '非 UTF-8 文本帧');
        }
        this.emit('message', text);
        return;
      }
      case OPCODE.BINARY: {
        return this.#fail(CLOSE_CODE.UNSUPPORTED_DATA, '本项目只接受文本帧');
      }
      default: {
        return this.#fail(CLOSE_CODE.PROTOCOL_ERROR, `未知 opcode ${opcode}`);
      }
    }
  }

  #write(opcode, payload) {
    if (!this.isOpen) return false;
    const frame = encodeFrame(opcode, payload, { masked: this.sendMasked });
    this.bytesOut += frame.length;
    return this.socket.write(frame);
  }

  /** 发送 JSON 或字符串 */
  send(data) {
    if (!this.isOpen) return false;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return this.#write(OPCODE.TEXT, Buffer.from(text, 'utf8'));
  }

  ping() {
    return this.#write(OPCODE.PING, EMPTY);
  }

  close(code = CLOSE_CODE.NORMAL, reason = '') {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code, reason)));
    } catch {
      /* ignore */
    }
    this.closed = true;
    this.socket.end();
    // 不立刻 emit close：等 socket 'close' 事件，保证对端能收到 close 帧
    setTimeout(() => this.#emitClose(code, reason), 50).unref?.();
  }

  /** 立即销毁（不优雅，用于兜底清理） */
  destroy() {
    this.closed = true;
    this.socket.destroy();
    this.#emitClose(1006, 'destroyed');
  }
}

function rejectUpgrade(socket, status, message) {
  const body = message || 'Bad Request';
  socket.write(
    `HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

/**
 * 处理 HTTP upgrade。成功返回 WSConnection，失败返回 null（已回 4xx）。
 */
export function acceptUpgrade(req, socket, head, opts = {}) {
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];

  if (upgrade !== 'websocket') return rejectUpgrade(socket, 400, 'Expect WebSocket upgrade'), null;
  if (!key || Buffer.from(key, 'base64').length !== 16) {
    return rejectUpgrade(socket, 400, 'Bad Sec-WebSocket-Key'), null;
  }
  if (version !== '13') return rejectUpgrade(socket, 426, 'Unsupported WebSocket Version'), null;

  const accept = computeAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const conn = new WSConnection(socket, opts);
  conn.feed(head);
  return conn;
}

/**
 * 测试用 WebSocket 客户端（同样是零依赖）。
 * 服务端 → 客户端方向的帧不带掩码，因此 requireMask=false、sendMasked=true。
 */
export function connectWS(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      // 必须绕开全局 agent：它会把 Connection / Upgrade 这类逐跳头剥掉，
      // 导致握手请求退化成普通 GET，服务端直接 404。
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('WebSocket 握手超时'));
    }, opts.timeout ?? 5000);

    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const expected = computeAccept(key);
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('Sec-WebSocket-Accept 校验失败'));
        return;
      }
      const conn = new WSConnection(socket, {
        requireMask: false,
        sendMasked: true,
        maxPayload: opts.maxPayload ?? 64 * 1024,
      });
      conn.feed(head);
      resolve(conn);
    });

    req.on('response', (res) => {
      clearTimeout(timer);
      reject(new Error(`握手被拒绝：HTTP ${res.statusCode}`));
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

/** 等待满足条件的第一条消息（超时抛错） */
export function waitFor(conn, predicate, { timeout = 3000, label = 'message' } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.off('message', onMessage);
      reject(new Error(`等待 ${label} 超时`));
    }, timeout);

    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      conn.off('message', onMessage);
      resolve(msg);
    }

    conn.on('message', onMessage);
  });
}
