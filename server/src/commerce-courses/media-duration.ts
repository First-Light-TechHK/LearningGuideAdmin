/**
 * 从 MP4 文件字节中解析时长（秒）。仅读取 moov/mvhd 头部，无需 ffprobe。
 * 找不到 mvhd 或解析失败时返回 null。
 */
export function mp4DurationSeconds(buf: Buffer): number | null {
  try {
    const idx = buf.indexOf("mvhd");
    if (idx < 0 || idx + 4 > buf.length) return null;
    const p = idx + 4; // payload 起点（version 字节）
    const version = buf[p];
    if (version === 1) {
      if (p + 32 > buf.length) return null;
      const timescale = buf.readUInt32BE(p + 20);
      const duration = Number(buf.readBigUInt64BE(p + 24));
      return timescale > 0 ? duration / timescale : null;
    }
    if (p + 20 > buf.length) return null;
    const timescale = buf.readUInt32BE(p + 12);
    const duration = buf.readUInt32BE(p + 16);
    return timescale > 0 ? duration / timescale : null;
  } catch {
    return null;
  }
}
