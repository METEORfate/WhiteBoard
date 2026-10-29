import test from 'node:test';
import assert from 'node:assert/strict';

import { Net } from '../client/js/net.js';

/**
 * Net 的消息处理单元测试：不连真实 socket，只验证「收到 ack / error 之后
 * 队列与在途状态怎么变」。这几条分支是最容易被改坏、又最难在浏览器里复现的地方。
 */

const STALE_OP = {
  opId: '11111111-1111-4111-8111-111111111111',
  roomId: 'room',
  clientId: 'client-aaaaaa',
  sessionEpoch: 'ep-111111',
  clientSeq: 7,
  kind: 'patch',
  target: '99999999-9999-4999-8999-999999999999',
  ver: 2,
  patch: { x: 777 },
  ts: 0,
};

const AUTH_SHAPE = {
  id: STALE_OP.target,
  type: 'rect',
  fields: { x: { val: 888, v: 5, c: 'client-zzzzzz', o: '22222222-2222-4222-8222-222222222222' } },
};

function makeNet() {
  const calls = [];
  const store = {
    pending: [STALE_OP],
    takePending: () => [...store.pending].sort((a, b) => a.clientSeq - b.clientSeq),
    dequeue: (opId) => {
      calls.push(['dequeue', opId]);
      store.pending = store.pending.filter((op) => op.opId !== opId);
    },
    adoptAuthoritative: (shape) => calls.push(['adoptAuthoritative', shape.id]),
    replaceAll: () => {},
    applyRemote: () => {},
    rebase: (op, shape) => {
      calls.push(['rebase', op.opId, shape.id]);
      return { opId: '33333333-3333-4333-8333-333333333333', ver: 6, rebased: true };
    },
  };
  const events = [];
  const net = new Net({
    roomId: 'room',
    identity: { clientId: 'client-aaaaaa', sessionEpoch: 'ep-111111', name: 'tester' },
    store,
    handlers: {
      onChange: () => events.push('change'),
      onConflict: (msg) => events.push(`conflict:${Boolean(msg.retried)}`),
      onLog: () => {},
      onStats: () => {},
    },
  });
  net._setState('online'); // 让 _pump 认为可以发送（不会真的建连接）
  return { net, store, calls, events };
}

test('ack 接受：只出队、不触发重基', () => {
  const { net, store, calls, events } = makeNet();
  net._onAck({ type: 'ack', opId: STALE_OP.opId, accepted: true, duplicate: false, seq: 9 });

  assert.equal(store.pending.length, 0);
  assert.deepEqual(calls, [['dequeue', STALE_OP.opId]]);
  assert.deepEqual(events, ['change']);
  clearTimeout(net._pumpTimer);
});

test('ack 拒绝：先采用权威态，再把 op 重基到最新版本并重发', () => {
  const { net, store, calls, events } = makeNet();
  net._onAck({ type: 'ack', opId: STALE_OP.opId, accepted: false, seq: null, shape: AUTH_SHAPE });

  assert.deepEqual(calls, [
    ['dequeue', STALE_OP.opId],
    ['adoptAuthoritative', AUTH_SHAPE.id],
    ['rebase', STALE_OP.opId, AUTH_SHAPE.id],
  ]);
  assert.ok(events.includes('conflict:true'), '冲突回调必须告诉 UI 这次是「重新应用」而不是「被覆盖」');
  assert.equal(store.pending.length, 0);
  clearTimeout(net._pumpTimer);
});

test('限流错误：清空在途标记并退避，队列不丢', () => {
  const { net, store } = makeNet();
  net._sent.add(STALE_OP.opId);

  net._onRejected({ type: 'error', code: 'RATE_LIMITED', message: '发送过快' });

  assert.equal(net._sent.size, 0, '在途标记必须清空，否则窗口会被永远占满');
  assert.equal(store.pending.length, 1, '限流不能丢 op');
  assert.ok(net._pumpTimer, '应安排一次退避后的重发');
  clearTimeout(net._pumpTimer);
});

test('带 opId 的结构性错误：把这条 op 摘掉，避免卡住队首', () => {
  const { net, store } = makeNet();
  net._sent.add(STALE_OP.opId);

  net._onRejected({ type: 'error', code: 'ROOM_FULL', message: '房间满了', opId: STALE_OP.opId });

  assert.equal(net._sent.size, 0);
  assert.equal(store.pending.length, 0);
  clearTimeout(net._pumpTimer);
});

test('发送节拍：一次 _pump 只发令牌桶允许的量，绝不把整队灌出去', () => {
  const { net, store } = makeNet();
  net._sent = new Set();
  net._send = () => true;
  store.pending = Array.from({ length: 100 }, (_, i) => ({
    ...STALE_OP,
    opId: `11111111-1111-4111-8111-0000000000${String(i).padStart(2, '0')}`,
    clientSeq: i + 1,
  }));

  net._pump();

  assert.ok(net._sent.size > 0, '应该发出至少一条');
  assert.ok(net._sent.size <= 32, `在途 ${net._sent.size} 条，超过窗口上限`);
  assert.ok(net._sent.size < store.pending.length, '不能一次全发');
  clearTimeout(net._pumpTimer);
});

test('在途 op 超过 ack 超时未确认：摘掉重发，不会永久占满窗口', () => {
  const { net } = makeNet();
  net._send = () => true;
  net._sent = new Set([STALE_OP.opId]);
  net._sentAt = new Map([[STALE_OP.opId, Date.now() - 6000]]);

  net._pump();

  assert.ok(net._sent.has(STALE_OP.opId), '超时后应重新发出，而不是一直占着位置');
  assert.ok(Date.now() - net._sentAt.get(STALE_OP.opId) < 1000, '发送时间戳应刷新');
  clearTimeout(net._pumpTimer);
});
