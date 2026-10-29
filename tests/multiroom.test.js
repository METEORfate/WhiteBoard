/**
 * 多房间相关的回归测试。
 *
 * 这里覆盖的是「访客可以自己建房」之后才暴露出来的四类问题：
 *   1. 房间号大小写归一（否则 Windows 上两个房间共用一个日志文件）
 *   2. 房间存在性探测（否则打错一个字就静默建了个空房间）
 *   3. 空闲房间回收（否则建房刷量能把内存吃光）
 *   4. 建房配额（同上，按 IP 限速）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync } from 'node:fs';

import {
  DATA_DIR,
  checkCreateQuota,
  newClient,
  reapRooms,
  rooms,
  sleep,
  startServer,
  stopServer,
  waitUntil,
} from './helpers.js';
import { CONFIG } from '../server/config.js';

const port = await startServer();

test.after(async () => {
  await stopServer();
});

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

test('房间号大小写归一：Team 与 team 是同一个房间，op 里的房间号也被归一化', async () => {
  const a = await newClient(port, 'CaseRoom', { name: 'A' });
  const b = await newClient(port, 'caseroom', { name: 'B' });

  // 内存里只应存在一个小写 key
  assert.ok(rooms.has('caseroom'), '房间以归一化后的小写 id 注册');
  assert.equal(rooms.has('CaseRoom'), false, '不应存在大小写不同的第二个房间');

  // A 用大写 roomId 发 op，服务端归一化后接受，B 能收到
  const { id, ack } = await a.createShape({ x: 5, y: 6, w: 30, h: 30 });
  assert.ok(ack, '大写 roomId 的 op 不应被 ROOM_MISMATCH 拒绝');
  assert.equal(ack.accepted, true);

  await waitUntil(() => b.shapes.has(id), { label: 'B 收到 A 的图形' });
  assert.equal(b.shapes.get(id).fields.x.val, 5);

  // 磁盘上只有一个日志文件，且文件名是小写
  const files = readdirSync(DATA_DIR).filter((f) => f.toLowerCase().startsWith('caseroom'));
  assert.deepEqual(files, ['caseroom.jsonl'], '磁盘上只有一个小写的房间日志');

  a.close();
  b.close();
  await sleep(80);
});

test('房间探测接口：不存在的房间返回 exists=false，存在则带在线人数与图形数', async () => {
  const ghost = `ghost-${Date.now().toString(36)}`;
  const miss = await getJson(`/api/rooms/${ghost}`);
  assert.equal(miss.status, 200);
  assert.equal(miss.body.exists, false, '没建过的房间必须是 false');
  assert.equal(miss.body.members, 0);

  const c = await newClient(port, 'probe-target');
  await c.createShape();

  // 大写房间号也能探测到（探测同样走归一化）
  const hit = await getJson('/api/rooms/PROBE-TARGET');
  assert.equal(hit.status, 200);
  assert.equal(hit.body.exists, true);
  assert.equal(hit.body.roomId, 'probe-target');
  assert.equal(hit.body.members, 1);
  assert.equal(hit.body.shapes, 1);

  // 非法房间号（中文）直接 400，不会因为「探测」而顺手建出一个房间
  const bad = await getJson(`/api/rooms/${encodeURIComponent('产品评审')}`);
  assert.equal(bad.status, 400);
  assert.equal(rooms.has('产品评审'), false);

  c.close();
  await sleep(80);
});

test('空闲房间会被卸载出内存，磁盘数据保留，再次进入自动恢复', async () => {
  const roomId = `reap-${Date.now().toString(36)}`;
  const c = await newClient(port, roomId);
  const { id } = await c.createShape({ x: 11, y: 22, w: 40, h: 40 });
  c.close();
  await sleep(120);

  assert.ok(rooms.has(roomId), '刚断开时房间还在内存里（方便马上回来）');

  // 有连接的房间不能被回收
  const live = await newClient(port, 'reap-live');
  const dropped = reapRooms({ now: Date.now() + 60_000, ttlMs: 1000 });
  assert.ok(dropped >= 1, '至少卸载了一个空闲房间');
  assert.equal(rooms.has(roomId), false, '空闲房间已卸载');
  assert.ok(rooms.has('reap-live'), '还有人在线的房间不受影响');
  live.close();

  // 数据没丢：重新进来从 jsonl 恢复
  const again = await newClient(port, roomId);
  assert.ok(
    again.welcome.shapes.some((s) => s.id === id),
    '卸载只是释放内存，磁盘日志仍在，重进即可恢复',
  );
  again.close();
  await sleep(80);
});

test('建房配额：同一 IP 超出每小时上限后被拒，换个 IP 仍可建', async () => {
  const ip = `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
  let allowed = 0;
  for (let i = 0; i < CONFIG.roomCreatePerHour + 5; i += 1) {
    if (checkCreateQuota({ ip })) break;
    allowed += 1;
  }
  assert.equal(allowed, CONFIG.roomCreatePerHour, '放行数等于配额');

  const denied = checkCreateQuota({ ip });
  assert.ok(denied, '超出配额必须被拒');
  assert.equal(denied.code, 'ROOM_RATE_LIMITED');
  assert.match(denied.message, /频繁/);

  // 配额是按 IP 记的，别人不受影响
  assert.equal(checkCreateQuota({ ip: `${ip}-other` }), null);
});
