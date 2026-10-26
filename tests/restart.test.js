import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectWS } from '../server/ws.js';
import { uuid } from '../shared/ids.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function pickPort() {
  return 21000 + Math.floor(Math.random() * 20000);
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

async function waitHealthy(port, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await getHealth(port);
    } catch {
      if (Date.now() > deadline) throw new Error('服务启动超时');
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

/** 用真实子进程跑服务端，才能测到「进程崩溃 + 重启」 */
function spawnServer(port, dataDir, bucket) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WB_QUIET: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  if (bucket) bucket.push(child);
  return child;
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null || child.killed) {
      return resolve();
    }
    const timer = setTimeout(resolve, 2000);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGKILL');
  });
}

async function connectAndHello(port, roomId) {
  const conn = await connectWS(`ws://127.0.0.1:${port}/ws`);
  const clientId = `t-${uuid().slice(0, 8)}`;
  const sessionEpoch = `ep-${uuid().slice(0, 8)}`;
  const inbox = [];
  conn.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  });

  let seq = 0;
  const sendOp = async (kind, target, patch, ver, shapeType) => {
    seq += 1;
    const opId = uuid();
    const op = {
      opId,
      roomId,
      clientId,
      sessionEpoch,
      clientSeq: seq,
      kind,
      target,
      shapeType,
      ver,
      patch,
      ts: Date.now(),
    };
    const before = inbox.length;
    conn.send({ type: 'op', op });
    const deadline = Date.now() + 3000;
    for (;;) {
      const found = inbox.slice(before).find((m) => m.type === 'ack' && m.opId === opId);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('等待 ack 超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  conn.send({ type: 'hello', roomId, clientId, sessionEpoch, name: 'restart-tester', lastSeq: 0 });
  const deadline = Date.now() + 3000;
  let welcome = null;
  while (!welcome) {
    welcome = inbox.find((m) => m.type === 'welcome');
    if (!welcome && Date.now() > deadline) throw new Error('等待 welcome 超时');
    if (!welcome) await new Promise((r) => setTimeout(r, 10));
  }

  return { conn, welcome, sendOp, clientId, sessionEpoch };
}

test('服务端崩溃重启：从日志恢复状态，bootEpoch 变化，坏尾行被修复', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-restart-'));
  const roomId = 'restart-room';
  const port = pickPort();
  const ids = [];
  const children = [];

  try {
    // ── 第一次启动 ──
    let child = spawnServer(port, dataDir, children);
    const health1 = await waitHealthy(port);

    let c = await connectAndHello(port, roomId);
    for (let i = 0; i < 3; i += 1) {
      const id = uuid();
      ids.push(id);
      const ack = await c.sendOp('create', id, { x: i * 30, y: i * 30, w: 50, h: 50, deleted: false }, 1, 'rect');
      assert.equal(ack.accepted, true);
    }
    c.conn.close();
    await new Promise((r) => setTimeout(r, 120));

    // ── 模拟崩溃：SIGKILL，然后在日志尾部写半行 ──
    await killChild(child);
    const logFile = join(dataDir, `${roomId}.jsonl`);
    appendFileSync(logFile, '{"seq":999,"shape":{"id":"truncated-line-without-newline"');

    // ── 第二次启动 ──
    child = spawnServer(port, dataDir, children);
    const health2 = await waitHealthy(port);

    assert.notEqual(health2.bootEpoch, health1.bootEpoch, '重启后 bootEpoch 必须变化');

    c = await connectAndHello(port, roomId);
    assert.equal(c.welcome.shapes.length, 3, '3 个图形全部恢复');
    assert.equal(c.welcome.serverSeq, 3, 'serverSeq 从日志最大值续上，不回退');

    const ids2 = c.welcome.shapes.map((s) => s.id).sort();
    assert.deepEqual(ids2, [...ids].sort(), '恢复的图形 id 与写入时一致');

    // 坏尾行已被重写修复：继续写入后再重启，数据不丢
    const extra = uuid();
    await c.sendOp('create', extra, { x: 1, y: 1, w: 9, h: 9, deleted: false }, 1, 'ellipse');
    c.conn.close();
    await new Promise((r) => setTimeout(r, 120));

    await killChild(child);
    child = spawnServer(port, dataDir, children);
    await waitHealthy(port);

    c = await connectAndHello(port, roomId);
    assert.equal(c.welcome.shapes.length, 4, '重启后新增的图形也在');
    assert.ok(c.welcome.shapes.some((s) => s.id === extra));

    // 日志中不应再有损坏行
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), '日志中不应残留半行');
    }

    c.conn.close();
    await killChild(child);
  } finally {
    for (const c of children) await killChild(c);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('重启后客户端重连：靠快照全量对齐，无需依赖旧的 serverSeq', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-restart2-'));
  const roomId = 'restart-room-2';
  const port = pickPort();
  let child;
  const children = [];

  try {
    child = spawnServer(port, dataDir, children);
    await waitHealthy(port);

    let c = await connectAndHello(port, roomId);
    const id = uuid();
    await c.sendOp('create', id, { x: 5, y: 5, w: 20, h: 20, deleted: false }, 1, 'text');
    c.conn.close();
    await new Promise((r) => setTimeout(r, 120));

    await killChild(child);
    child = spawnServer(port, dataDir, children);
    await waitHealthy(port);

    c = await connectAndHello(port, roomId);
    // 客户端可能带着旧的 lastSeq 来，服务端用 bootEpoch 让它走全量
    assert.ok(c.welcome.bootEpoch);
    assert.equal(c.welcome.shapes.length, 1);
    assert.equal(c.welcome.shapes[0].fields.x.val, 5);

    c.conn.close();
    await killChild(child);
  } finally {
    for (const c of children) await killChild(c);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
