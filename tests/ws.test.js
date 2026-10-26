import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { computeAccept, encodeFrame, OPCODE } from '../server/ws.js';
import { startServer, stopServer } from './helpers.js';

let port;

before(async () => {
  port = await startServer();
});

after(async () => {
  await stopServer();
});

// ── 握手 ──────────────────────────────────────────────────────

test('computeAccept 必须与 RFC6455 官方测试向量一致', () => {
  // RFC6455 §1.3：这个向量是握手实现唯一的"外部真相"。
  // 如果魔数写错，自测（自己写的客户端连自己写的服务端）依然会全绿，
  // 但任何真实浏览器都会拒绝握手 —— 所以必须对着官方向量断言。
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('标准 WebSocket 客户端（Node 内置 undici）能完成握手并收到 welcome', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('标准客户端握手失败（accept 校验不通过）'));
    setTimeout(() => reject(new Error('握手超时')), 4000);
  });
  await opened;

  const welcome = await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => resolve(JSON.parse(ev.data));
    ws.send(
      JSON.stringify({
        type: 'hello',
        roomId: 'ws-std',
        clientId: 'c-stdclient1',
        sessionEpoch: 'ep-stdclient',
        name: '标准客户端',
        lastSeq: 0,
      }),
    );
    setTimeout(() => reject(new Error('等待 welcome 超时')), 3000);
  });

  assert.equal(welcome.type, 'welcome');
  assert.ok(Array.isArray(welcome.shapes));
  ws.close();
});

// ── 帧编解码 ──────────────────────────────────────────────────

test('encodeFrame 覆盖 7 位 / 16 位 / 64 位长度编码', () => {
  const small = encodeFrame(OPCODE.TEXT, Buffer.from('hi'));
  assert.equal(small.length, 4);
  assert.equal(small[0], 0x81);
  assert.equal(small[1], 2);

  const mid = encodeFrame(OPCODE.TEXT, Buffer.alloc(200));
  assert.equal(mid[1], 126);
  assert.equal(mid.readUInt16BE(2), 200);

  const big = encodeFrame(OPCODE.TEXT, Buffer.alloc(70000));
  assert.equal(big[1], 127);
  assert.equal(Number(big.readBigUInt64BE(2)), 70000);
});

test('掩码帧编解码可逆', () => {
  const payload = Buffer.from('掩码测试 payload');
  const masked = encodeFrame(OPCODE.TEXT, payload, { masked: true });
  assert.equal(masked[1] & 0x80, 0x80, '应带 MASK 位');
  const mask = masked.subarray(2, 6);
  const body = masked.subarray(6);
  const restored = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) restored[i] = body[i] ^ mask[i & 3];
  assert.deepEqual(restored, payload);
});

// ── 协议异常处理（裸 socket 直接发畸形帧）────────────────────

function rawHandshake() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buf.subarray(0, end).toString();
      if (!head.startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error(`握手失败：${head.split('\r\n')[0]}`));
        return;
      }
      resolve({ socket, rest: buf.subarray(end + 4), head });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('握手超时')), 4000);
  });
}

function makeReader(initial) {
  let buf = initial && initial.length ? initial : Buffer.alloc(0);
  return {
    feed(chunk) {
      buf = Buffer.concat([buf, chunk]);
    },
    next() {
      if (buf.length < 2) return null;
      const b0 = buf[0];
      const b1 = buf[1];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return null;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return null;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (b1 & 0x80) offset += 4; // 服务端不该发掩码帧，兜底
      if (buf.length < offset + len) return null;
      const payload = buf.subarray(offset, offset + len);
      buf = buf.subarray(offset + len);
      return { opcode: b0 & 0x0f, payload };
    },
  };
}

function waitClose(socket, reader, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 close 帧超时')), timeout);
    const pump = () => {
      for (;;) {
        const frame = reader.next();
        if (!frame) return;
        if (frame.opcode === OPCODE.CLOSE) {
          clearTimeout(timer);
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          resolve(code);
          return;
        }
      }
    };
    socket.on('data', (chunk) => {
      reader.feed(chunk);
      pump();
    });
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new Error('连接被直接关闭，没有收到 close 帧'));
    });
    pump();
  });
}

test('未掩码的客户端帧 → 1002 协议错误', async () => {
  const { socket, rest } = await rawHandshake();
  const reader = makeReader(rest);
  const closed = waitClose(socket, reader);
  socket.write(encodeFrame(OPCODE.TEXT, Buffer.from('{}'), { masked: false }));
  assert.equal(await closed, 1002);
  socket.destroy();
});

test('非法 UTF-8 文本帧 → 1007', async () => {
  const { socket, rest } = await rawHandshake();
  const reader = makeReader(rest);
  const closed = waitClose(socket, reader);
  socket.write(encodeFrame(OPCODE.TEXT, Buffer.from([0xc3, 0x28]), { masked: true }));
  assert.equal(await closed, 1007);
  socket.destroy();
});

test('二进制帧 → 1003（本项目只接受文本）', async () => {
  const { socket, rest } = await rawHandshake();
  const reader = makeReader(rest);
  const closed = waitClose(socket, reader);
  socket.write(encodeFrame(OPCODE.BINARY, Buffer.from([1, 2, 3]), { masked: true }));
  assert.equal(await closed, 1003);
  socket.destroy();
});

test('超过 64KB 的帧 → 1009', async () => {
  const { socket, rest } = await rawHandshake();
  const reader = makeReader(rest);
  const closed = waitClose(socket, reader);
  socket.write(encodeFrame(OPCODE.TEXT, Buffer.alloc(80 * 1024, 0x61), { masked: true }));
  assert.equal(await closed, 1009);
  socket.destroy();
});

test('RSV 位非 0 → 1002', async () => {
  const { socket, rest } = await rawHandshake();
  const reader = makeReader(rest);
  const closed = waitClose(socket, reader);
  const frame = encodeFrame(OPCODE.TEXT, Buffer.from('{}'), { masked: true });
  frame[0] |= 0x40; // 置 RSV1
  socket.write(frame);
  assert.equal(await closed, 1002);
  socket.destroy();
});

test('分片消息可正确重组（hello 拆成两帧）', async () => {
  const { socket, rest } = await rawHandshake();
  const reader = makeReader(rest);

  const hello = JSON.stringify({
    type: 'hello',
    roomId: 'ws-fragment',
    clientId: 'c-fragment1',
    sessionEpoch: 'ep-fragment',
    name: '分片客户端',
    lastSeq: 0,
  });
  const half = Math.floor(hello.length / 2);

  socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(hello.slice(0, half), 'utf8'), { masked: true, fin: false }));
  socket.write(encodeFrame(OPCODE.CONT, Buffer.from(hello.slice(half), 'utf8'), { masked: true, fin: true }));

  const welcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 welcome 超时')), 3000);
    socket.on('data', (chunk) => {
      reader.feed(chunk);
      for (;;) {
        const frame = reader.next();
        if (!frame) return;
        if (frame.opcode !== OPCODE.TEXT) continue;
        const msg = JSON.parse(frame.payload.toString('utf8'));
        if (msg.type === 'welcome') {
          clearTimeout(timer);
          resolve(msg);
          return;
        }
      }
    });
  });

  assert.equal(welcome.type, 'welcome');
  socket.destroy();
});

test('ping 控制帧会被 pong 回应', async () => {
  const { socket, rest } = await rawHandshake();
  const reader = makeReader(rest);
  socket.write(encodeFrame(OPCODE.PING, Buffer.from('hb'), { masked: true }));

  const pong = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 pong 超时')), 3000);
    socket.on('data', (chunk) => {
      reader.feed(chunk);
      for (;;) {
        const frame = reader.next();
        if (!frame) return;
        if (frame.opcode === OPCODE.PONG) {
          clearTimeout(timer);
          resolve(frame.payload.toString());
          return;
        }
      }
    });
  });

  assert.equal(pong, 'hb');
  socket.destroy();
});
