import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp from 'sharp';
import { extname, join } from 'node:path';
import { types } from 'node:util';
import { Worker } from 'node:worker_threads';

export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 60_000_000;
const MAX_ANIMATION_PIXELS = 120_000_000;
const MAX_FRAMES = 120;
const MAX_ACTIVE_DECODES = 2;
const PREVIEW_EDGE = 2560;
let activeDecodes = 0;
let heicWorkerBusy = false;

type PreviewExtension = 'png' | 'jpg' | 'gif' | 'webp';

async function decodeHeic(bytes: Buffer): Promise<Buffer> {
  if (heicWorkerBusy) {
    throw new ServiceUnavailableException('图片处理繁忙，请稍后重试');
  }
  heicWorkerBusy = true;
  let worker: Worker | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // A disposable worker releases the decoder's WebAssembly heap after each upload.
    const decoder = new Worker(
      join(__dirname, `knowledge-heif.worker${extname(__filename)}`),
      {
        workerData: {
          bytes,
          maxPixels: MAX_INPUT_PIXELS,
          previewEdge: PREVIEW_EDGE,
        },
      },
    );
    worker = decoder;
    return await new Promise<Buffer>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('HEIC decode timed out')),
        30_000,
      );
      decoder.once('error', reject);
      decoder.once('exit', () =>
        reject(new Error('HEIC worker exited before returning an image')),
      );
      decoder.once('message', (preview: unknown) => {
        if (!types.isUint8Array(preview) || !preview.length) {
          reject(new Error('HEIC worker returned an invalid image'));
          return;
        }
        resolve(
          Buffer.from(preview.buffer, preview.byteOffset, preview.byteLength),
        );
      });
    });
  } finally {
    clearTimeout(timeout);
    try {
      await worker?.terminate();
    } finally {
      heicWorkerBusy = false;
    }
  }
}

function checkDimensions(width: number, height: number, frames = 1) {
  if (
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_INPUT_PIXELS ||
    frames < 1 ||
    frames > MAX_FRAMES ||
    width * height * frames > MAX_ANIMATION_PIXELS
  ) {
    throw new BadRequestException('图片的像素数或动画帧数超过限制');
  }
}

// PNG decoders may only expose the default frame of an APNG.
function pngFrames(bytes: Buffer): number {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (size > bytes.length - offset - 12) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL' && size === 8) return bytes.readUInt32BE(offset + 8);
    if (type === 'IDAT') break;
    offset += size + 12;
  }
  return 1;
}

function bitmapInput(bytes: Buffer) {
  const wrapped = bytes.toString('ascii', 0, 2) === 'BM';
  const header = wrapped ? 14 : 0;
  if (bytes.length < header + 40) return null;
  const headerSize = bytes.readUInt32LE(header);
  if (!wrapped && ![40, 52, 56, 108, 124].includes(headerSize)) return null;
  const width = bytes.readInt32LE(header + 4);
  const signedHeight = bytes.readInt32LE(header + 8);
  const height = Math.abs(signedHeight);
  const bits = bytes.readUInt16LE(header + 14);
  const offset = wrapped ? bytes.readUInt32LE(10) : headerSize;
  if (
    headerSize < 40 ||
    offset < header + headerSize ||
    bytes.readUInt16LE(header + 12) !== 1 ||
    ![24, 32].includes(bits) ||
    bytes.readUInt32LE(header + 16) !== 0
  ) {
    throw new BadRequestException('仅支持未压缩的 24 位或 32 位 BMP/DIB 图片');
  }
  checkDimensions(width, height);
  const channels = bits / 8;
  const stride = Math.ceil((width * channels) / 4) * 4;
  if (offset + stride * height > bytes.length)
    throw new Error('Truncated bitmap');
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = signedHeight < 0 ? y : height - y - 1;
    for (let x = 0; x < width; x++) {
      const src = offset + row * stride + x * channels;
      const dst = (y * width + x) * 3;
      rgb[dst] = bytes[src + 2];
      rgb[dst + 1] = bytes[src + 1];
      rgb[dst + 2] = bytes[src];
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } });
}

export async function prepareKnowledgeImage(
  bytes: Buffer,
): Promise<{ bytes: Buffer; extension: PreviewExtension }> {
  if (activeDecodes >= MAX_ACTIVE_DECODES) {
    throw new ServiceUnavailableException('图片处理繁忙，请稍后重试');
  }
  activeDecodes++;
  let format: string | undefined;
  try {
    const bitmap = bitmapInput(bytes);
    if (bitmap)
      return {
        bytes: await bitmap
          .resize(PREVIEW_EDGE, PREVIEW_EDGE, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png()
          .toBuffer(),
        extension: 'png',
      };

    const image = sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'warning',
    });
    const metadata = await image.metadata();
    format = metadata.format;
    const extensions = {
      jpeg: 'jpg',
      png: 'png',
      gif: 'gif',
      webp: 'webp',
    } as const;
    const original = extensions[format as keyof typeof extensions] as
      PreviewExtension | undefined;
    const frames =
      format === 'png'
        ? pngFrames(bytes)
        : original
          ? (metadata.pages ?? 1)
          : 1;
    checkDimensions(
      metadata.width,
      metadata.pageHeight ?? metadata.height,
      frames,
    );
    if (original) {
      if (frames > 1 && format !== 'png') {
        await sharp(bytes, {
          animated: true,
          limitInputPixels: MAX_ANIMATION_PIXELS,
        }).stats();
      } else {
        await image.stats();
      }
      return { bytes, extension: original };
    }
    if (!['tiff', 'heif', 'svg'].includes(format)) {
      throw new BadRequestException('不支持此图片格式');
    }
    if (format === 'heif' && metadata.compression === 'hevc') {
      return { bytes: await decodeHeic(bytes), extension: 'png' };
    }
    // Only serve raster output. Never serve the uploaded SVG as executable XML.
    const preview = await image
      .autoOrient()
      .resize(PREVIEW_EDGE, PREVIEW_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    return { bytes: preview, extension: 'png' };
  } catch (error) {
    if (
      error instanceof BadRequestException ||
      error instanceof ServiceUnavailableException
    )
      throw error;
    if (format === 'heif') {
      throw new BadRequestException(
        '无法解码 HEIC、HEIF 或 AVIF 图片，请尝试导出为 JPEG 或 PNG',
      );
    }
    throw new BadRequestException('图片已损坏或格式不受支持');
  } finally {
    activeDecodes--;
  }
}
