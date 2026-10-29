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
  /**
   * clientSeq 高水位表（`clientId:sessionEpoch` → seq）上限。
   * 每次重连都会产生一个新的 sessionEpoch，key 只增不减就是一条缓慢上升的内存曲线，
   * 因此按 LRU 封顶。淘汰的安全性见 room.js 里 rememberHwm 的注释。
   */
  hwmLimit: 500,
  /**
   * 远端光标的合并窗口：同一房间内这个时间窗里的 move 帧合并成一次广播。
   * 鼠标移动是「只要最新值」的高频数据，逐帧转发在 10 人房间里是纯浪费。
   */
  presenceFlushMs: 50,
  /** 握手前等待的 op 帧上限，超了强制重连 */
  pendingFrameLimit: 2000,
  /**
   * 空房间在内存里保留多久（无连接、无操作）。
   * 到期只是把 Room 从内存卸载，磁盘上的 jsonl 保留——下次有人进来会重新加载。
   * 访客能自由建房之后，这条是防止「建一万个房间把内存吃光」的兜底。
   */
  roomIdleTtlMs: Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000),
  /** 内存中同时驻留的房间上限 */
  maxRooms: Number(process.env.MAX_ROOMS || 500),
  /** 单个 IP 每小时最多创建多少个新房间（进已有房间不消耗配额） */
  roomCreatePerHour: Number(process.env.ROOM_CREATE_PER_HOUR || 60),
  /** 房间探测接口的每 IP 令牌桶：每分钟补充数 / 桶容量 */
  roomProbePerMin: Number(process.env.ROOM_PROBE_PER_MIN || 30),
});
