/**
 * 端到端验证脚本（可选工具，不参与运行时）。
 *
 * 用 CDP 驱动本机 Chrome 打开两个标签页，模拟真实的「画图 → 同步 → 断网 → 恢复」流程，
 * 并截图存档。不依赖 Playwright / Puppeteer，只用了项目自带的 WebSocket 客户端。
 *
 * 目标地址上没有服务时会自动起一个临时服务端（用临时 DATA_DIR，跑完即删），
 * 所以直接 `node scripts/e2e.mjs` 就行；要测已有实例则用 --url 指定。
 *
 * 用法：node scripts/e2e.mjs [--url http://127.0.0.1:8787] [--out docs/screenshots]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectWS } from '../server/ws.js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE_URL = argOf('--url', 'http://127.0.0.1:8787');
const OUT_DIR = argOf('--out', 'docs/screenshots');
const DEBUG_PORT = 9333 + Math.floor(Math.random() * 200);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge，可用 CHROME_PATH 环境变量指定');
}

function httpJSON(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: DEBUG_PORT, path, method, agent: false },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`CDP 返回非 JSON：${body.slice(0, 120)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(conn) {
    this.conn = conn;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.consoleErrors = [];
    conn.on('message', (raw) => this._onMessage(raw));
  }

  static async attach(wsUrl) {
    const conn = await connectWS(wsUrl, { maxPayload: 32 * 1024 * 1024 });
    const cdp = new CDP(conn);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    return cdp;
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    this.events.push(msg);

    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.consoleErrors.push(`[exception] ${d.text} ${d.exception?.description || ''}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      this.consoleErrors.push(`[console.error] ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      this.consoleErrors.push(`[log] ${msg.params.entry.text}`);
    }
  }

  send(method, params = {}, timeout = 15_000) {
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.conn.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, timeout);
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面内异常：${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result.value;
  }

  async waitFor(expression, { timeout = 8000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = await this.evaluate(expression).catch(() => false);
      if (v) return v;
      if (Date.now() > deadline) {
        const diag = await this.evaluate(
          'location.href + " | ready=" + document.readyState + " | board=" + typeof window.__board',
        ).catch((e) => `诊断失败 ${e.message}`);
        throw new Error(`等待超时：${label}（${diag}）`);
      }
      await sleep(80);
    }
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  }

  async drag(from, to, steps = 8) {
    await this.mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await this.mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.mouse('mouseMoved', x, y);
      await sleep(16);
    }
    await this.mouse('mouseReleased', to.x, to.y);
    await sleep(80);
  }

  async click(x, y) {
    await this.mouse('mouseMoved', x, y, { buttons: 0 });
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
    await sleep(60);
  }

  /**
   * 截图。后台标签页的合成器可能不产出新帧，`Page.captureScreenshot` 会一直等到
   * CDP 超时。所以先把目标页切到前台再截，并且带重试；三次都失败就跳过——
   * 截图是留证材料，不是功能断言，不该让它把整轮结果作废。
   */
  async screenshot(path) {
    const name = path.split(/[\\/]/).pop();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.send('Page.bringToFront', {}, 5_000).catch(() => {});
        await sleep(300);
        const res = await this.send(
          'Page.captureScreenshot',
          { format: 'png', fromSurface: true, captureBeyondViewport: false },
          20_000,
        );
        writeFileSync(path, Buffer.from(res.data, 'base64'));
        return true;
      } catch (err) {
        if (attempt === 3) {
          console.warn(`  ⚠ 截图失败（${name}）：${err.message}，已跳过`);
          return false;
        }
        await sleep(600);
      }
    }
    return false;
  }
}

async function newPage(url) {
  await httpJSON(`/json/new?${encodeURI(url)}`, 'PUT');
  const deadline = Date.now() + 10_000;
  for (;;) {
    const list = await httpJSON('/json/list');
    const target = list.find((t) => t.type === 'page' && t.url.startsWith(url.split('?')[0]));
    if (target && target.webSocketDebuggerUrl) return target;
    if (Date.now() > deadline) throw new Error('创建标签页超时');
    await sleep(100);
  }
}

const results = [];
const openClients = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 探一下目标地址是否已经有服务在跑 */
function probe(baseUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL('/healthz', baseUrl);
    const req = http.get(
      { host: u.hostname, port: u.port || 80, path: u.pathname, agent: false, timeout: 1500 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('healthz 超时')));
  });
}

/** 没服务就起一个临时的；有服务就复用（返回 null） */
async function ensureServer() {
  try {
    await probe(BASE_URL);
    return null;
  } catch {
    /* 继续，自己起一个 */
  }
  const port = Number(new URL(BASE_URL).port || 8787);
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-e2e-data-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, STRICT_PORT: '1', WB_QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => {
    log += d.toString();
  });
  child.stderr.on('data', (d) => {
    log += d.toString();
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`临时服务端启动失败（退出码 ${child.exitCode}）：\n${log.slice(-800)}`);
    }
    try {
      await probe(BASE_URL);
      return { child, dataDir };
    } catch {
      if (Date.now() > deadline) throw new Error(`临时服务端 15s 内未就绪：\n${log.slice(-800)}`);
      await sleep(120);
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'wb-chrome-'));
  const chrome = findChrome();
  console.log(`使用浏览器：${chrome}`);
  console.log(`调试端口：${DEBUG_PORT}`);

  // 目标地址没起服务就自己起一个：README 只写了「跑这个脚本」，
  // 不该要求使用者先记得另开一个终端把服务端跑起来。
  const server = await ensureServer();
  if (server) console.log(`已自动启动临时服务端：${BASE_URL}（数据目录 ${server.dataDir}）`);

  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (server) {
      try {
        server.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        rmSync(server.dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };

  try {
    // 等 CDP 就绪
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await httpJSON('/json/version');
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('Chrome 调试端口未就绪');
        await sleep(150);
      }
    }

    const room = `e2e-${Date.now().toString(36)}`;
    const url = `${BASE_URL}/?room=${room}`;

    // ── 页面 A ──
    const a = await CDP.attach((await newPage(url)).webSocketDebuggerUrl);
    openClients.push(a);
    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await a.waitFor('!!window.__board');
    await a.waitFor('document.getElementById("status").dataset.state === "online"', {
      label: 'A 进入在线状态',
    });
    check('页面 A 建立 WebSocket 连接并完成握手', true);

    // 画一个矩形
    await a.click(...(await a.evaluate('(() => { const r = document.getElementById("toolbar").querySelector("[data-tool=rect]").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()')));
    await a.drag({ x: 380, y: 260 }, { x: 560, y: 400 });
    let count = await a.evaluate('window.__board.store.list().length');
    check('A 用矩形工具画出一个矩形', count === 1, `图形数 ${count}`);

    // ── 页面 B ──
    const b = await CDP.attach((await newPage(url)).webSocketDebuggerUrl);
    openClients.push(b);
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.waitFor('!!window.__board');
    await b.waitFor('window.__board.store.list().length === 1', { label: 'B 收到 A 的图形' });
    check('页面 B 加入同一房间后立即看到 A 画的矩形', true);

    const shapeA = await a.evaluate(
      '(() => { const s = window.__board.store.list()[0]; return { id: s.id, x: s.fields.x.val, y: s.fields.y.val, w: s.fields.w.val }; })()',
    );
    const shapeB = await b.evaluate(
      '(() => { const s = window.__board.store.list()[0]; return { id: s.id, x: s.fields.x.val, y: s.fields.y.val, w: s.fields.w.val }; })()',
    );
    check(
      '两端图形 id 与几何完全一致',
      JSON.stringify(shapeA) === JSON.stringify(shapeB),
      `A=${JSON.stringify(shapeA)} B=${JSON.stringify(shapeB)}`,
    );

    // B 画椭圆
    await b.click(...(await b.evaluate('(() => { const r = document.getElementById("toolbar").querySelector("[data-tool=ellipse]").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()')));
    await b.drag({ x: 680, y: 260 }, { x: 860, y: 400 });
    const bAfterEllipse = await b.evaluate(
      'JSON.stringify({ n: window.__board.store.list().length, tool: window.__board.interactions.tool, types: window.__board.store.list().map(s => s.type) })',
    );
    check('B 本地成功画出椭圆', JSON.parse(bAfterEllipse).n === 2, bAfterEllipse);
    const bNet = await b.evaluate(
      'JSON.stringify({ net: window.__board.net.stats(), pending: window.__board.store.pending.length, log: [...document.querySelectorAll("#debug-log div")].slice(-6).map(d => d.textContent) })',
    );
    console.log('      B 状态：', bNet);
    await a.waitFor('window.__board.store.list().length === 2', { label: 'A 收到 B 的椭圆' });
    check('A 实时收到 B 画的椭圆（双向同步）', true);

    // B 输入文本
    await b.click(...(await b.evaluate('(() => { const r = document.getElementById("toolbar").querySelector("[data-tool=text]").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()')));
    await b.click(420, 520);
    await sleep(150);
    await b.send('Input.insertText', { text: '离线协作白板' });
    await sleep(80);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter' });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' });
    await sleep(250);
    const textCount = await b.evaluate('window.__board.store.list().filter(s => s.type === "text").length');
    check('文本工具可创建文本图形', textCount === 1, `文本图形 ${textCount} 个`);
    await a.waitFor('window.__board.store.list().length === 3', { label: 'A 收到文本' });

    await a.screenshot(join(OUT_DIR, '01-two-clients.png'));

    // ── 断网：A 继续编辑 ──
    await a.evaluate('window.__board.net.setSimulatedOffline(true)');
    await a.waitFor('document.getElementById("status").dataset.state === "offline"', { label: 'A 进入离线状态' });
    check('A 断网后状态条切换为「离线」', true);

    await a.evaluate('window.__board.interactions.setTool("rect")');
    await a.drag({ x: 300, y: 620 }, { x: 420, y: 700 });
    await a.evaluate('window.__board.interactions.setTool("rect")');
    await a.drag({ x: 460, y: 620 }, { x: 580, y: 700 });
    const aOffline = await a.evaluate('window.__board.store.list().length');
    const bDuring = await b.evaluate('window.__board.store.list().length');
    const queued = await a.evaluate('window.__board.store.pending.length');
    check('断网期间 A 仍可继续绘制', aOffline === 5, `A 本地 ${aOffline} 个图形`);
    check('断网期间的修改只进本地队列，未同步给 B', bDuring === 3 && queued >= 2, `B 仍 ${bDuring} 个 / 队列 ${queued} 条`);

    await a.screenshot(join(OUT_DIR, '02-offline-queue.png'));

    // ── 恢复网络 ──
    await a.evaluate('window.__board.net.setSimulatedOffline(false)');
    await a.waitFor('document.getElementById("status").dataset.state === "online"', {
      label: 'A 重连成功',
      timeout: 10_000,
    });
    await b.waitFor('window.__board.store.list().length === 5', { label: 'B 收到离线期间的图形' });
    await a.waitFor('window.__board.store.pending.length === 0', { label: 'A 队列清空' });

    const digestA = await a.evaluate('JSON.stringify(window.__board.store.digest())');
    const digestB = await b.evaluate('JSON.stringify(window.__board.store.digest())');
    check('重连后两端状态完全一致（digest 相同）', digestA === digestB, `${digestA.length} 字节指纹`);
    check('离线队列全部清空', true);

    // ── 并发编辑同一图形 ──
    await a.evaluate(`(() => {
      const s = window.__board.store.list()[0];
      window.__board.interactions.selection = new Set([s.id]);
      window.__board.interactions.setTool('select');
      return s.id;
    })()`);
    await b.evaluate(`(() => {
      const s = window.__board.store.list()[0];
      window.__board.interactions.selection = new Set([s.id]);
      window.__board.interactions.setTool('select');
      return s.id;
    })()`);

    await Promise.all([
      a.evaluate(`(() => { const s = window.__board.store.list()[0]; window.__board.store.applyLocal(s.id, { fill: '#fde68a' }, { label: '并发改色' }); })()`),
      b.evaluate(`(() => { const s = window.__board.store.list()[0]; window.__board.store.applyLocal(s.id, { x: 120 }, { label: '并发移动' }); })()`),
    ]);
    await sleep(600);

    const merged = await a.evaluate(`(() => {
      const s = window.__board.store.list()[0];
      return { x: s.fields.x.val, fill: s.fields.fill.val };
    })()`);
    const mergedB = await b.evaluate(`(() => {
      const s = window.__board.store.list()[0];
      return { x: s.fields.x.val, fill: s.fields.fill.val };
    })()`);
    check(
      '并发修改不同字段：两个操作都被保留（字段级 LWW）',
      merged.x === 120 && merged.fill === '#fde68a',
      `x=${merged.x} fill=${merged.fill}`,
    );
    check('并发后两端收敛到同一状态', JSON.stringify(merged) === JSON.stringify(mergedB));

    await a.screenshot(join(OUT_DIR, '03-after-merge.png'));
    await b.screenshot(join(OUT_DIR, '04-client-b.png'));

    // ── 控制台错误检查 ──
    const errors = [...a.consoleErrors, ...b.consoleErrors];
    check('页面无未捕获异常 / console.error', errors.length === 0, errors.slice(0, 3).join(' | '));

    // ── 汇总 ──
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n通过 ${passed}/${results.length}`);
    writeFileSync(
      join(OUT_DIR, 'e2e-result.json'),
      JSON.stringify({ at: new Date().toISOString(), room, passed, total: results.length, results }, null, 2),
    );
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error('E2E 失败：', err.message);
  for (const [i, c] of openClients.entries()) {
    if (c.consoleErrors.length) {
      console.error(`--- 页面 ${i + 1} 控制台错误 ---`);
      for (const line of c.consoleErrors.slice(0, 12)) console.error('  ' + line);
    }
  }
  // 中断时也把已完成的检查落盘，报告里能看出「跑到哪一步挂的」，而不是一片空白
  if (results.length) {
    const passed = results.filter((r) => r.ok).length;
    try {
      writeFileSync(
        join(OUT_DIR, 'e2e-result.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            aborted: true,
            error: err.message,
            passed,
            total: results.length,
            results,
          },
          null,
          2,
        ),
      );
    } catch {
      /* ignore */
    }
  }
  process.exitCode = 1;
});
