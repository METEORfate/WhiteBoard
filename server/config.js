/** 服务端运行配置 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(here, '..');

export const CONFIG = Object.freeze({
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || resolve(ROOT_DIR, 'data'),
  entry: 'client/index.html',
  /** 挂载点 → 磁盘目录，只有这两个目录对外可见 */
  mounts: {
    '/client/': resolve(ROOT_DIR, 'client'),
    '/shared/': resolve(ROOT_DIR, 'shared'),
  },
  /** hello 必须在这个时间内到达 */
  helloTimeoutMs: 10_000,
  /** 客户端每 15s ping 一次，超过这个时间没收到任何帧就判定死连接 */
  idleTimeoutMs: 60_000,
  /** 日志行数超过阈值时压缩成快照 */
  compactAfterLines: 500,
  /** 幂等去重表上限（Map 按插入序淘汰最老的） */
  seenOpLimit: 50_000,
  /** 握手前等待的 op 帧上限，超了强制重连 */
  pendingFrameLimit: 2000,
});
