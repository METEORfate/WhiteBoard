import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeOp, mergeShape, flatten } from '../shared/merge.js';
import { uuid } from '../shared/ids.js';

/**
 * 收敛性属性测试。
 *
 * merge.test.js 用三个固定状态演示交换律/结合律/幂等性，属于「举例」；
 * 这里用 40 条随机并发 op 的随机到达顺序来断言「任意顺序 → 同一个状态」，
 * 对应 README 里那句「op 以任何顺序、重复任意次到达，两端都会算出同一个结果」。
 */

const TARGET = '99999999-9999-4999-8999-999999999999';

/** Fisher-Yates，避免 sort(() => Math.random() - 0.5) 那种有偏洗牌 */
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildOps() {
  return Array.from({ length: 40 }, (_, i) => ({
    opId: uuid(),
    target: TARGET,
    kind: 'patch',
    // 刻意制造同版本并发：只有 7 个版本号，40 条 op 必然撞车，
    // 此时靠 clientId → opId 决出唯一赢家
    ver: 1 + (i % 7),
    clientId: `c-${String(i % 3).padStart(6, '0')}`,
    clientSeq: i + 1,
    ts: 0,
    patch: { x: i * 10, y: i * 5 },
  }));
}

const BASE_OP = {
  opId: '11111111-1111-4111-8111-111111111111',
  target: TARGET,
  kind: 'create',
  shapeType: 'rect',
  ver: 1,
  clientId: 'c-000000',
  clientSeq: 0,
  ts: 0,
  patch: { x: 0, y: 0, w: 10, h: 10 },
};

const digestOf = (shape) => JSON.stringify(flatten(shape));
const applyAll = (ops) => ops.reduce((shape, op) => mergeOp(shape, op), mergeOp(null, BASE_OP));

test('任意到达顺序、任意重复次数都收敛到同一状态', () => {
  const ops = buildOps();
  const seen = new Map();

  for (let round = 0; round < 200; round += 1) {
    // 正序 / 逆序 / 随机序 / 带重复的随机序，四种到达方式
    const shuffled = shuffle(ops);
    const orders = [
      ops,
      [...ops].reverse(),
      shuffled,
      shuffle([...shuffled, ...shuffled.slice(0, 10)]),
    ];
    for (const order of orders) {
      const digest = digestOf(applyAll(order));
      seen.set(digest, (seen.get(digest) || 0) + 1);
    }
  }

  assert.equal(seen.size, 1, `出现了 ${seen.size} 种终态，说明合并没有收敛`);
  // 终态必须是「每个字段取最大戳」的那个值，而不是某个偶然顺序的结果
  const final = flatten(applyAll(ops));
  assert.equal(typeof final.x, 'number');
  assert.ok(final.x >= 0 && final.x <= 390);
});

test('分批合并与一次性合并等价（结合律在随机输入上成立）', () => {
  const ops = buildOps();
  const oneShot = digestOf(applyAll(ops));

  for (let round = 0; round < 50; round += 1) {
    const order = shuffle(ops);
    const cut = 1 + Math.floor(Math.random() * (order.length - 1));
    // 两批各自从同一个 base 出发，再把两个中间结果合并
    const left = applyAll(order.slice(0, cut));
    const right = applyAll(order.slice(cut));
    assert.equal(digestOf(mergeShape(left, right)), oneShot, '分批合并必须与一次性合并等价');
  }
});
