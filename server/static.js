/**
 * 静态文件服务：只暴露 client/ 与 shared/ 两个目录。
 * 路径穿越（../、绝对路径、符号链接逃逸）一律 403。
 */

import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** URL 路径 → 磁盘路径，非法返回 null */
export function resolveSafe(rootDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null; // 非法百分号编码
  }
  if (decoded.includes('\0')) return null;

  const root = resolve(rootDir);
  const target = resolve(join(root, normalize(decoded)));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

/**
 * @param {{rootDir: string, entry: string, mounts: Record<string,string>}} opts
 *        mounts: { '/client/': '<rootDir>/client', '/shared/': '<rootDir>/shared' }
 */
export function createStaticHandler(opts) {
  const { rootDir, entry, mounts } = opts;

  return function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return true;
    }

    const urlPath = (req.url || '/').split('?')[0].split('#')[0] || '/';
    if (urlPath === '/' || urlPath === '/index.html') {
      return serveFile(req, res, resolve(rootDir, entry));
    }

    for (const [prefix, dir] of Object.entries(mounts)) {
      if (!urlPath.startsWith(prefix)) continue;
      const target = resolveSafe(dir, urlPath.slice(prefix.length));
      if (!target) {
        send(res, 403, 'Forbidden');
        return true;
      }
      return serveFile(req, res, target);
    }

    return false; // 交给上层做 404 / 其他路由
  };
}

function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    send(res, 404, 'Not Found');
    return true;
  }
  if (!stat.isFile()) {
    send(res, 404, 'Not Found');
    return true;
  }

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}
