/**
 * 房间状态持久化：追加写 JSONL + 启动重放 + 定期压缩。
 *
 * 关键点：append 是同步写。服务端必须「先落盘、再广播」——
 * 否则进程在广播后崩溃，客户端已经确认过的 op 就永久丢失了。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalRoomId } from '../shared/protocol.js';

export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.lineCounts = new Map();
  }

  /**
   * 房间日志文件路径。
   * 这里必须归一化房间号：NTFS / APFS 大小写不敏感，`Team.jsonl` 与 `team.jsonl`
   * 是同一个文件，但内存里是两个 Room——不归一化就会出现「两个房间共用一个日志」。
   */
  fileOf(roomId) {
    return join(this.dir, `${canonicalRoomId(roomId)}.jsonl`);
  }

  /** 磁盘上是否已有这个房间的数据（不加载，只 stat） */
  has(roomId) {
    try {
      return statSync(this.fileOf(roomId)).size > 0;
    } catch {
      return false;
    }
  }

  /**
   * 重放房间日志。
   * 容忍崩溃留下的半行（JSON.parse 失败即跳过），
   * serverSeq 取日志中出现过的最大值，避免重启后序号回退导致客户端误判重放。
   */
  load(roomId) {
    const shapes = new Map();
    let seq = 0;
    const file = this.fileOf(roomId);
    if (!existsSync(file)) {
      this.lineCounts.set(roomId, 0);
      return { shapes, seq, lines: 0, truncated: 0 };
    }

    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      this.lineCounts.set(roomId, 0);
      return { shapes, seq, lines: 0, truncated: 0 };
    }

    let lines = 0;
    let truncated = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        truncated += 1; // 崩溃时可能留下半行
        continue;
      }
      lines += 1;

      if (rec && rec.snapshot === true && Array.isArray(rec.shapes)) {
        shapes.clear();
        for (const shape of rec.shapes) {
          if (shape && shape.id) shapes.set(shape.id, shape);
        }
        if (typeof rec.seq === 'number' && rec.seq > seq) seq = rec.seq;
        continue;
      }

      if (!rec || typeof rec.seq !== 'number' || !rec.shape || !rec.shape.id) continue;
      shapes.set(rec.shape.id, rec.shape);
      if (rec.seq > seq) seq = rec.seq;
    }

    this.lineCounts.set(roomId, lines);
    if (truncated > 0) {
      // 崩溃留下的半行会与下一次 append 粘成一行新的坏数据，
      // 因此加载后立刻用内存态重写文件（原子 rename）。
      this.compact(roomId, [...shapes.values()], seq);
      this.lineCounts.set(roomId, 1);
    }
    return { shapes, seq, lines: truncated > 0 ? 1 : lines, truncated };
  }

  append(roomId, record) {
    appendFileSync(this.fileOf(roomId), `${JSON.stringify(record)}\n`);
    const next = (this.lineCounts.get(roomId) || 0) + 1;
    this.lineCounts.set(roomId, next);
    return next;
  }

  /** 原子压缩：写临时文件后 rename，避免压缩过程中崩溃导致日志损坏 */
  compact(roomId, shapes, seq) {
    const payload = `${JSON.stringify({ snapshot: true, seq, shapes })}\n`;
    const tmp = `${this.fileOf(roomId)}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, this.fileOf(roomId));
    this.lineCounts.set(roomId, 1);
  }

  lineCount(roomId) {
    return this.lineCounts.get(roomId) || 0;
  }
}
