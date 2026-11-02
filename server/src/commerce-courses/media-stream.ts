import type { Response } from 'express';

import { contentTypeFor } from './content-type';
import { CourseStorageService } from './storage.service';

/** 单次 Range 响应最多读取多少字节。 */
const CHUNK_BYTES = 8 * 1024 * 1024;

export interface MediaTarget {
  storageKey: string;
  extension: string;
  /** 已知字节数（数据库 size 字段），用于避免每次 HEAD 存储。 */
  size?: number | null;
}

/**
 * 课程媒体的统一输出（2026-11-02）。
 *
 * 为什么单独抽出来：视频要能「试播」，就必须支持 HTTP Range，
 * 否则浏览器无法拖动进度、Safari 甚至完全不播。
 *
 * 同一份实现同时给「课程编辑 / 学员视角预览 / 在 Portal 中预览」和
 * 正式 Portal 投影使用，保证它们读的是同一个存储对象。
 */
export async function sendMedia(
  res: Response,
  storage: CourseStorageService,
  target: MediaTarget,
): Promise<boolean> {
  const total =
    typeof target.size === 'number' && target.size >= 0
      ? target.size
      : await storage.mediaSize(target.storageKey);
  if (total === null) return false;

  res.setHeader('Content-Type', contentTypeFor(target.extension));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');

  const rangeHeader = res.req?.headers?.range;
  const range = rangeHeader ? parseRange(rangeHeader, total) : null;
  if (range === 'invalid') {
    res.status(416).setHeader('Content-Range', `bytes */${total}`);
    res.end();
    return true;
  }

  if (!range) {
    const bytes = await storage.getMedia(target.storageKey);
    res.setHeader('Content-Length', String(bytes.length));
    res.end(bytes);
    return true;
  }

  const length = Math.min(range.end - range.start + 1, CHUNK_BYTES);
  const bytes = await storage.getMediaRange(
    target.storageKey,
    range.start,
    length,
  );
  const end = range.start + bytes.length - 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${range.start}-${end}/${total}`);
  res.setHeader('Content-Length', String(bytes.length));
  res.end(bytes);
  return true;
}

function parseRange(
  header: string,
  total: number,
): { start: number; end: number } | 'invalid' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start >= total ||
    end < start
  )
    return 'invalid';
  return { start, end: Math.min(end, total - 1) };
}

