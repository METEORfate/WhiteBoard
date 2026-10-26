#!/usr/bin/env node
/**
 * 生成 docs/测试报告.md
 *
 * 做法：对每个用例文件单独跑一次 `node --test --test-reporter=junit`，
 * 解析 JUnit XML 拿到「文件 → 用例」的归属关系和每条用例的耗时。
 *
 * 为什么不一次性跑全部再解析：Node 的 JUnit 输出把所有用例拍平成
 * classname="test"，丢掉文件归属；逐个文件跑能保留分组，代价是多了几次
 * 进程启动（本机约 3 秒），换来一份能直接贴进交付文档的表格。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const OUT_FILE = path.join(ROOT, 'docs', '测试报告.md');
const E2E_FILE = path.join(ROOT, 'docs', 'screenshots', 'e2e-result.json');

/** 按「自底向上」排：先证数学模型，再证协议，最后证整机。 */
const FILES = [
  ['merge.test.js', '字段级 LWW 合并 · 一致性模型的数学地基'],
  ['protocol.test.js', '协议校验与归一化 · 非法数据的第一道闸门'],
  ['ws.test.js', 'WebSocket 协议实现 · 握手/分帧/掩码/分片'],
  ['sync.test.js', '多端实时同步 · 幂等、乱序、并发、房间隔离'],
  ['offline.test.js', '离线队列与重连 · 断网继续编辑、恢复后补齐'],
  ['restart.test.js', '服务端重启与端口冲突 · 持久化、快照恢复、自动顺延'],
  ['client-store.test.js', '浏览器端文档状态 · 乐观应用与远端合并'],
];

/** 需求 → 用例文件的追溯矩阵，方便评审逐条对照。 */
const TRACE = [
  ['① 至少两种图形（矩形/圆形/文本）', 'e2e #2 #5 #7', '浏览器内实际绘制三种图形'],
  ['② 创建、移动、编辑、删除、缩放、撤销', 'e2e #2 #5 #7 / client-store', '工具状态机 + 撤销栈'],
  ['③ WebSocket 多端实时同步', 'sync.test.js / e2e #3 #6', '双端消息往返与状态收敛'],
  ['④ 房间/文档标识隔离', 'sync.test.js', '跨房间广播不串台'],
  ['⑤ 本地保存未同步操作', 'offline.test.js / e2e #9 #10', 'localStorage 队列持久化'],
  ['⑥ 网络恢复后同步离线操作', 'offline.test.js / e2e #11 #12', '重连补发 + 快照对齐'],
  ['⑦ 处理并发编辑、重复操作、非法数据', 'merge / protocol / sync', 'LWW / 幂等去重 / 白名单校验'],
  ['非功能① 不损坏数据结构', 'merge（交换律/结合律/幂等）', '收敛性由数学性质保证'],
  ['非功能③ 至少一个并发或断网恢复测试', 'offline.test.js / e2e #8–#14', '两类场景均有覆盖'],
];

// ---------------------------------------------------------------------------
// 执行与解析
// ---------------------------------------------------------------------------

function runFile(file) {
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=junit', path.join('tests', file)],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  const wallMs = Date.now() - started;
  const xml = res.stdout || '';
  const cases = parseJUnit(xml);
  return {
    file,
    cases,
    wallMs,
    // 解析到用例时以用例结果为准；一条都没解析出来说明进程本身炸了
    ok: cases.length > 0 && cases.every((c) => c.ok),
    stderr: (res.stderr || '').split('\n')
      .filter((l) => l.trim() && !l.includes('UNDICI-EHPA') && !l.includes('trace-warnings'))
      .join('\n'),
    raw: xml,
  };
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function parseJUnit(xml) {
  const out = [];
  // 自闭合 <testcase .../> 与成对 <testcase ...>...</testcase> 都要覆盖
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[3] || '';
    const name = /name="([^"]*)"/.exec(attrs);
    const time = /time="([^"]*)"/.exec(attrs);
    const failure = /<failure\b[^>]*message="([^"]*)"/.exec(body);
    const error = /<error\b[^>]*message="([^"]*)"/.exec(body);
    const skipped = /<skipped\b/.test(body);
    out.push({
      name: name ? unescapeXml(name[1]) : '(未命名)',
      ms: time ? Math.round(Number(time[1]) * 1000) : 0,
      ok: !failure && !error,
      skipped,
      message: failure ? unescapeXml(failure[1]) : error ? unescapeXml(error[1]) : '',
    });
  }
  return out;
}

function fmtMs(ms) {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 表格单元格里不能出现裸 | 和换行，否则会撑破列。 */
function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 报告正文
// ---------------------------------------------------------------------------

function build() {
  console.log('运行单元测试…');
  const runs = FILES.map(([file, title]) => {
    const r = runFile(file);
    r.title = title;
    const pass = r.cases.filter((c) => c.ok).length;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${file}  ${pass}/${r.cases.length}  ${fmtMs(r.wallMs)}`);
    return r;
  });

  const allCases = runs.flatMap((r) => r.cases);
  const passed = allCases.filter((c) => c.ok).length;
  const failed = allCases.length - passed;
  const sumMs = allCases.reduce((a, c) => a + c.ms, 0);
  const wallMs = runs.reduce((a, r) => a + r.wallMs, 0);
  const rate = allCases.length ? ((passed / allCases.length) * 100).toFixed(1) : '0.0';

  let e2e = null;
  if (existsSync(E2E_FILE)) {
    try {
      e2e = JSON.parse(readFileSync(E2E_FILE, 'utf8'));
    } catch {
      e2e = null;
    }
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const L = [];
  L.push('# 测试报告');
  L.push('');
  L.push('> 本文件由 `npm run report` 自动生成（`scripts/report.js`），请勿手工编辑。');
  L.push('');
  L.push(`生成时间：${stamp}　|　Node ${process.version}　|　${process.platform} ${process.arch}`);
  L.push('');
  L.push('## 一、总览');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('| --- | --- |');
  L.push(`| 单元 / 集成用例 | **${allCases.length}** 条，通过 **${passed}**，失败 **${failed}** |`);
  L.push(`| 通过率 | **${rate}%** |`);
  L.push(`| 用例累计耗时 | ${fmtMs(sumMs)}（含进程启动合计 ${fmtMs(wallMs)}） |`);
  L.push(`| 覆盖模块 | ${runs.length} 个文件：合并算法、协议校验、WebSocket 帧、同步服务、离线重连、持久化、客户端状态 |`);
  if (e2e) {
    L.push(`| 浏览器端到端 | **${e2e.passed}/${e2e.total}** 通过（真实 Chrome，双标签页，房间 \`${e2e.room}\`） |`);
  }
  L.push('');
  L.push(failed === 0 && (!e2e || e2e.passed === e2e.total)
    ? '**结论：全部通过。**'
    : '**结论：存在失败用例，详见下文红色标记。**');
  L.push('');

  // --- 用例明细 ---
  L.push('## 二、用例明细');
  L.push('');
  runs.forEach((r, i) => {
    const p = r.cases.filter((c) => c.ok).length;
    L.push(`### 2.${i + 1} \`${r.file}\`：${r.title}`);
    L.push('');
    L.push(`结果：${p}/${r.cases.length} 通过，耗时 ${fmtMs(r.wallMs)}`);
    L.push('');
    if (r.cases.length === 0) {
      L.push('> ⚠️ 该文件没有产出任何用例结果，可能是语法错误或进程异常退出。');
      if (r.stderr) {
        L.push('');
        L.push('```text');
        L.push(r.stderr.split('\n').slice(0, 20).join('\n'));
        L.push('```');
      }
      L.push('');
      return;
    }
    L.push('| # | 用例 | 结果 | 耗时 |');
    L.push('| --- | --- | --- | --- |');
    r.cases.forEach((c, j) => {
      L.push(`| ${j + 1} | ${cell(c.name)} | ${c.ok ? '✅' : '❌'} | ${fmtMs(c.ms)} |`);
    });
    L.push('');
    const bad = r.cases.filter((c) => !c.ok);
    if (bad.length) {
      L.push('失败详情：');
      L.push('');
      bad.forEach((c) => {
        L.push(`- **${cell(c.name)}**`);
        L.push('');
        L.push('  ```text');
        L.push('  ' + (c.message || '(无错误信息)').split('\n').slice(0, 12).join('\n  '));
        L.push('  ```');
      });
      L.push('');
    }
  });

  // --- 端到端 ---
  L.push('## 三、浏览器端到端验证');
  L.push('');
  if (!e2e) {
    L.push('未找到 `docs/screenshots/e2e-result.json`，先运行 `node scripts/e2e.mjs` 再生成报告。');
    L.push('');
  } else {
    L.push('用本机 Chrome + 裸 CDP 驱动两个真实标签页（非模拟环境），验证「两人协作」的完整链路。');
    L.push('');
    L.push(`执行时间：${e2e.at}　房间：\`${e2e.room}\`　结果：**${e2e.passed}/${e2e.total}**`);
    L.push('');
    L.push('| # | 检查项 | 结果 | 观测值 |');
    L.push('| --- | --- | --- | --- |');
    e2e.results.forEach((r, i) => {
      const detail = r.detail ? cell(r.detail).slice(0, 160) : '—';
      L.push(`| ${i + 1} | ${cell(r.name)} | ${r.ok ? '✅' : '❌'} | ${detail} |`);
    });
    L.push('');
    L.push('截图（`docs/screenshots/`）：');
    L.push('');
    L.push('- `01-two-clients.png` — 两个标签页同房间实时同步');
    L.push('- `02-offline-queue.png` — 断网后本地继续绘制，队列积压');
    L.push('- `03-after-merge.png` — 重连后离线操作补齐、两端一致');
    L.push('- `04-client-b.png` — 对端视角确认');
    L.push('');
  }

  // --- 追溯矩阵 ---
  L.push('## 四、需求覆盖追溯');
  L.push('');
  L.push('| 需求条目 | 对应验证 | 验证方式 |');
  L.push('| --- | --- | --- |');
  TRACE.forEach(([req, where, how]) => {
    L.push(`| ${cell(req)} | ${cell(where)} | ${cell(how)} |`);
  });
  L.push('');

  // --- 关键回归 ---
  L.push('## 五、关键回归用例');
  L.push('');
  L.push('以下用例是为两个「单测全绿但线上必炸」的真实缺陷补的回归，属于本项目的红线：');
  L.push('');
  L.push('| 缺陷 | 现象 | 回归用例 |');
  L.push('| --- | --- | --- |');
  L.push('| 握手 GUID 常量写错 | 自研客户端能连，任何真实浏览器握手被拒 | `ws.test.js` — RFC 6455 官方向量 + Node 内置 `WebSocket` 真客户端握手 |');
  L.push('| 合并函数用错语义 | 浏览器里实时同步静默失效，控制台报 `Cannot convert undefined or null to object` | `client-store.test.js` — 远端 shape 合并路径 |');
  L.push('');
  L.push('## 六、如何复现');
  L.push('');
  L.push('```bash');
  L.push('npm test          # 仅单元 / 集成用例');
  L.push('node scripts/e2e.mjs   # 浏览器端到端（需本机安装 Chrome）');
  L.push('npm run report    # 重新生成本报告');
  L.push('```');
  L.push('');
  L.push('测试数据目录由 `tests/helpers.js` 为每个用例创建独立的临时 `DATA_DIR`，用例之间互不影响，也不会污染仓库里的 `data/`。');
  L.push('');

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, L.join('\n'), 'utf8');

  console.log('');
  console.log(`用例 ${passed}/${allCases.length} 通过（${rate}%），耗时 ${fmtMs(sumMs)}`);
  if (e2e) console.log(`端到端 ${e2e.passed}/${e2e.total}`);
  console.log(`报告已写入 ${path.relative(ROOT, OUT_FILE)}`);

  return failed === 0 && (!e2e || e2e.passed === e2e.total);
}

const ok = build();
process.exit(ok ? 0 : 1);
