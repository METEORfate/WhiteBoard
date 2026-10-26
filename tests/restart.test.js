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
function spawnServer(port, dataDir, bucket, extraEnv = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      WB_QUIET: '0',
      // 父进程环境里若设了 STRICT_PORT，会让「自动顺延」的用例失效，这里显式清掉
      STRICT_PORT: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 端口冲突的提示语是行为的一部分，必须能断言到，所以把输出收集起来
  child.output = '';
  const collect = (buf) => {
    child.output += buf.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  if (bucket) bucket.push(child);
  return child;
}

/** 等子进程输出里出现某个模式（用于读它实际监听的端口） */
function waitForOutput(child, re, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      const m = re.exec(child.output || '');
      if (m) return resolve(m);
      if (Date.now() > deadline) {
        return reject(new Error(`等待输出超时 ${re}，实际输出：${(child.output || '').slice(-300)}`));
      }
      return setTimeout(tick, 40);
    };
    tick();
  });
}

/** 从「白板服务已启动 http://localhost:PORT」里取实际端口 */
async function actualPort(child) {
  const m = await waitForOutput(child, /已启动 http:\/\/localhost:(\d+)/);
  return Number(m[1]);
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

test('端口被占用时自动顺延，两个实例可共存', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-port-'));
  const children = [];

  try {
    // A 用 PORT=0 让系统分配端口——避免和本机其他进程抢固定端口，用例才稳定
    const a = spawnServer(0, dataDir, children);
    const portA = await actualPort(a);
    await waitHealthy(portA);

    // B 抢同一个端口，必须顺延，且不能影响 A
    const b = spawnServer(portA, dataDir, children);
    await waitForOutput(b, new RegExp(`改用 ${portA + 1}`));
    const portB = await actualPort(b);

    assert.ok(portB > portA, `B 应顺延到更大的端口，实际 ${portB}`);
    assert.ok(b.output.includes(`端口 ${portA} 已被占用`), 'B 的日志说明了顺延原因');
    assert.ok((await waitHealthy(portB)).ok, 'B 在顺延后的端口上正常工作');
    assert.ok((await getHealth(portA)).ok, 'A 不受影响');

    await killChild(a);
    await killChild(b);
  } finally {
    for (const c of children) await killChild(c);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('STRICT_PORT=1 时端口冲突立即失败，给出可操作提示而不是堆栈', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-strict-'));
  const children = [];

  try {
    const a = spawnServer(0, dataDir, children);
    const portA = await actualPort(a);
    await waitHealthy(portA);

    const b = spawnServer(portA, dataDir, children, { STRICT_PORT: '1' });
    const code = await new Promise((resolve) => b.once('exit', resolve));

    assert.equal(code, 1, '冲突时以退出码 1 结束');
    assert.match(b.output, /已被占用/, '说明了失败原因');
    assert.match(b.output, /Get-NetTCPConnection/, '给出了可直接复制的排查命令');
    assert.match(b.output, /\$env:PORT=0/, '给出了让系统分配端口的用法');
    // 关键：不能再是「throw er; // Unhandled 'error' event」那种原始堆栈
    assert.doesNotMatch(b.output, /setupListenHandle|Unhandled 'error' event/);

    await killChild(a);
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
