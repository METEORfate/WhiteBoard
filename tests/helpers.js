/**
 * 测试基础设施：起一个真实 HTTP+WS 服务，用零依赖的裸 WebSocket 客户端连上去。
 * 每个测试文件在独立进程里跑，因此各自拥有独立的临时数据目录。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = mkdtempSync(join(tmpdir(), 'wb-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.WB_QUIET = process.env.WB_QUIET ?? '1';

const serverMod = await import('../server/index.js');
const wsMod = await import('../server/ws.js');
const idsMod = await import('../shared/ids.js');
const mergeMod = await import('../shared/merge.js');

export const { start, stop, rooms, BOOT_EPOCH } = serverMod;
export const { connectWS, waitFor } = wsMod;
export const { uuid, newSessionEpoch, shortId } = idsMod;
export const { mergeShape, isVisible, flatten } = mergeMod;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待条件成立 */
export async function waitUntil(fn, { timeout = 3000, interval = 15, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`);
    await sleep(interval);
  }
}

export class TestClient {
  constructor(conn, roomId, identity = {}) {
    this.conn = conn;
    this.roomId = roomId;
    this.clientId = identity.clientId || `t-${shortId(8)}`;
    this.sessionEpoch = identity.sessionEpoch || newSessionEpoch();
    this.clientSeq = identity.clientSeq || 0;
    this.inbox = [];
    this.errors = [];
    this.resyncs = 0;
    this.shapes = new Map();
    this.lastApplied = 0;
    this.gaps = 0;
    this.bootEpoch = null;
    this.welcome = null;

    conn.on('message', (raw) => this._onMessage(raw));
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.inbox.push(msg);

    switch (msg.type) {
      case 'welcome': {
        this.bootEpoch = msg.bootEpoch;
        this.shapes = new Map((msg.shapes || []).map((s) => [s.id, s]));
        this.lastApplied = msg.serverSeq || 0;
        this.welcome = msg;
        break;
      }
      case 'op': {
        if (msg.bootEpoch !== this.bootEpoch) break;
        if (msg.seq <= this.lastApplied) break; // 重放/乱序旧帧
        if (this.lastApplied > 0 && msg.seq !== this.lastApplied + 1) this.gaps += 1;
        const cur = this.shapes.get(msg.shape.id);
        this.shapes.set(
          msg.shape.id,
          cur ? mergeShape(cur, msg.shape, { authoritative: true }) : msg.shape,
        );
        this.lastApplied = msg.seq;
        break;
      }
      case 'error':
        this.errors.push(msg);
        break;
      case 'resync':
        this.resyncs += 1;
        break;
      default:
        break;
    }
  }

  async hello({ name = 'tester' } = {}) {
    this.conn.send({
      type: 'hello',
      roomId: this.roomId,
      clientId: this.clientId,
      sessionEpoch: this.sessionEpoch,
      name,
      lastSeq: 0,
    });
    return waitFor(this.conn, (m) => m.type === 'welcome', { label: 'welcome' });
  }

  /** 组装一条 op（不改 clientSeq） */
  buildOp({ kind = 'patch', target, patch, ver = 1, shapeType, opId }) {
    return {
      opId: opId || uuid(),
      roomId: this.roomId,
      clientId: this.clientId,
      sessionEpoch: this.sessionEpoch,
      clientSeq: this.clientSeq + 1,
      kind,
      target,
      shapeType,
      ver,
      patch,
      ts: Date.now(),
    };
  }

  /**
   * 发送 op 并等待「ack 或 error」——被拒绝的 op 只回 error 不回 ack，
   * 只等 ack 会白白等满超时。
   * @returns {Promise<object|null>} ack 消息；被拒绝时返回 null（错误记录在 client.errors）
   */
  async sendRawOp(op, { timeout = 2000 } = {}) {
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待 ack/error 超时（${op.opId.slice(0, 8)}）`));
      }, timeout);

      const onMessage = (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === 'ack' && msg.opId === op.opId) {
          cleanup();
          resolve(msg);
        } else if (msg.type === 'error') {
          cleanup();
          resolve(null);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.conn.off('message', onMessage);
      };

      this.conn.on('message', onMessage);
      this.conn.send({ type: 'op', op });
    });
    return outcome;
  }

  async sendOp(spec) {
    this.clientSeq += 1;
    const op = this.buildOp(spec);
    const ack = await this.sendRawOp(op);
    return { op, ack };
  }

  async createShape({ type = 'rect', x = 10, y = 10, w = 120, h = 90, patch = {} } = {}) {
    const target = uuid();
    const { op, ack } = await this.sendOp({
      kind: 'create',
      target,
      shapeType: type,
      ver: 1,
      patch: { x, y, w, h, deleted: false, ...patch },
    });
    return { id: target, op, ack };
  }

  async patchShape(target, patch, ver) {
    return this.sendOp({ kind: 'patch', target, patch, ver });
  }

  async deleteShape(target, ver) {
    return this.sendOp({ kind: 'delete', target, patch: { deleted: true }, ver });
  }

  visible() {
    return [...this.shapes.values()].filter((s) => isVisible(s));
  }

  shape(id) {
    return this.shapes.get(id);
  }

  close() {
    this.conn.close();
  }
}

/** 起服务并返回随机端口 */
export async function startServer() {
  const port = await start(0);
  return port;
}

export async function stopServer() {
  await stop();
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 连接 + hello */
export async function newClient(port, roomId, opts = {}) {
  const conn = await connectWS(`ws://127.0.0.1:${port}/ws`);
  const client = new TestClient(conn, roomId, opts);
  if (opts.hello !== false) await client.hello(opts);
  return client;
}
