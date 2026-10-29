import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, stopServer } from './helpers.js';

test('生产代理从回环地址访问也不能读取房间统计，本地开发仍可诊断', async () => {
  const original = process.env.NODE_ENV;
  const port = await startServer();
  try {
    process.env.NODE_ENV = 'development';
    const local = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(local.status, 200);
    assert.ok(Array.isArray((await local.json()).rooms));

    process.env.NODE_ENV = 'production';
    const proxied = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    });
    assert.equal(proxied.status, 403);
    const body = await proxied.json();
    assert.equal(body.error, 'FORBIDDEN');
    assert.equal(body.rooms, undefined);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
    await stopServer();
  }
});
