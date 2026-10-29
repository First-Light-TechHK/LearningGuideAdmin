import path from 'node:path';
import type { CommerceCourseConfig } from './commerce.config';

/**
 * 媒体文件类型与签名校验（移植自 Portal services/courseMedia.ts，精简为课程包/上传所需的子集）。
 * 返回规范化的 kind + 规范化扩展名；不合法抛 MediaValidationError。
 */
export class MediaValidationError extends Error {
  constructor(
    public code:
      | 'too_large'
      | 'unsupported'
      | 'invalid'
      | 'filename',
    message: string,
  ) {
    super(message);
  }
}

export type MediaKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'PDF' | 'MODEL3D';

interface Format {
  kind: MediaKind;
  mime: string;
  accepted: string[];
  maxBytesKey: keyof CommerceCourseConfig;
}

const FORMATS: Record<string, Format> = {
  jpg: { kind: 'IMAGE', mime: 'image/jpeg', accepted: ['image/jpeg'], maxBytesKey: 'maxImageBytes' },
  jpeg: { kind: 'IMAGE', mime: 'image/jpeg', accepted: ['image/jpeg'], maxBytesKey: 'maxImageBytes' },
  png: { kind: 'IMAGE', mime: 'image/png', accepted: ['image/png'], maxBytesKey: 'maxImageBytes' },
  gif: { kind: 'IMAGE', mime: 'image/gif', accepted: ['image/gif'], maxBytesKey: 'maxImageBytes' },
  webp: { kind: 'IMAGE', mime: 'image/webp', accepted: ['image/webp'], maxBytesKey: 'maxImageBytes' },
  pdf: { kind: 'PDF', mime: 'application/pdf', accepted: ['application/pdf'], maxBytesKey: 'maxPdfBytes' },
  mp4: { kind: 'VIDEO', mime: 'video/mp4', accepted: ['video/mp4'], maxBytesKey: 'maxVideoBytes' },
  mov: { kind: 'VIDEO', mime: 'video/quicktime', accepted: ['video/quicktime'], maxBytesKey: 'maxVideoBytes' },
  webm: { kind: 'VIDEO', mime: 'video/webm', accepted: ['video/webm'], maxBytesKey: 'maxVideoBytes' },
  mp3: { kind: 'AUDIO', mime: 'audio/mpeg', accepted: ['audio/mpeg', 'audio/mp3'], maxBytesKey: 'maxAudioBytes' },
  wav: { kind: 'AUDIO', mime: 'audio/wav', accepted: ['audio/wav', 'audio/x-wav'], maxBytesKey: 'maxAudioBytes' },
  ogg: { kind: 'AUDIO', mime: 'audio/ogg', accepted: ['audio/ogg'], maxBytesKey: 'maxAudioBytes' },
  m4a: { kind: 'AUDIO', mime: 'audio/mp4', accepted: ['audio/mp4', 'audio/x-m4a'], maxBytesKey: 'maxAudioBytes' },
  flac: { kind: 'AUDIO', mime: 'audio/flac', accepted: ['audio/flac'], maxBytesKey: 'maxAudioBytes' },
  obj: { kind: 'MODEL3D', mime: 'model/obj', accepted: ['model/obj', 'text/plain', 'application/octet-stream'], maxBytesKey: 'maxModelBytes' },
  glb: { kind: 'MODEL3D', mime: 'model/gltf-binary', accepted: ['model/gltf-binary', 'application/octet-stream'], maxBytesKey: 'maxModelBytes' },
};

function starts(bytes: Buffer, hex: string): boolean {
  return bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
}

function matchesSignature(bytes: Buffer, ext: string): boolean {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return bytes.length >= 4 && starts(bytes, 'ffd8ff');
    case 'png':
      return bytes.length >= 12 && starts(bytes, '89504e470d0a1a0a');
    case 'gif':
      return /GIF8[79]a/.test(bytes.toString('ascii', 0, 6));
    case 'webp':
      return (
        bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP'
      );
    case 'pdf':
      return /^%PDF-/.test(bytes.toString('ascii', 0, 8));
    case 'mp4':
    case 'mov':
    case 'm4a':
      return (
        bytes.length >= 12 &&
        bytes.toString('ascii', 4, 8) === 'ftyp'
      );
    case 'webm':
      return starts(bytes, '1a45dfa3');
    case 'mp3':
      return (
        starts(bytes, 'ff') ||
        bytes.toString('ascii', 0, 3) === 'ID3'
      );
    case 'wav':
      return bytes.toString('ascii', 0, 4) === 'RIFF';
    case 'ogg':
      return bytes.toString('ascii', 0, 4) === 'OggS';
    case 'flac':
      return bytes.toString('ascii', 0, 4) === 'fLaC';
    case 'glb':
      return bytes.toString('ascii', 0, 4) === 'glTF';
    case 'obj':
      return bytes.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(bytes.toString('utf8', 0, Math.min(4096, bytes.length)));
    default:
      return false;
  }
}

export interface ValidatedMedia {
  kind: MediaKind;
  mimeType: string;
  extension: string;
  size: number;
  originalName: string;
}

export function validateMediaFile(
  input: { name: string; type?: string; bytes: Buffer },
  config: CommerceCourseConfig,
): ValidatedMedia {
  if (
    typeof input.name !== 'string' ||
    input.name.length > 255 ||
    /[\u0000-\u001f\u007f/\\]/.test(input.name)
  ) {
    throw new MediaValidationError('filename', 'Invalid filename.');
  }
  const extension = path.extname(input.name).slice(1).toLowerCase();
  const format = FORMATS[extension];
  if (!format) {
    throw new MediaValidationError(
      'unsupported',
      `Unsupported file extension: ${extension || '(none)'}`,
    );
  }
  const max = Number(config[format.maxBytesKey]);
  if (input.bytes.length === 0) {
    throw new MediaValidationError('invalid', 'File is empty.');
  }
  if (input.bytes.length > max) {
    throw new MediaValidationError('too_large', 'File exceeds size limit.');
  }
  const mime = (input.type ?? '').toLowerCase().trim();
  if (mime && !format.accepted.includes(mime)) {
    throw new MediaValidationError(
      'unsupported',
      `Media type ${mime} does not match extension .${extension}`,
    );
  }
  if (!matchesSignature(input.bytes, extension)) {
    throw new MediaValidationError(
      'unsupported',
      'File signature does not match its extension.',
    );
  }
  return {
    kind: format.kind,
    mimeType: format.mime,
    extension,
    size: input.bytes.length,
    originalName: input.name,
  };
}

export function maxBytesForKind(
  kind: MediaKind,
  config: CommerceCourseConfig,
): number {
  switch (kind) {
    case 'IMAGE':
      return config.maxImageBytes;
    case 'VIDEO':
      return config.maxVideoBytes;
    case 'AUDIO':
      return config.maxAudioBytes;
    case 'PDF':
      return config.maxPdfBytes;
    case 'MODEL3D':
      return config.maxModelBytes;
  }
}
