const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
};

export function contentTypeFor(extension: string): string {
  const ext = (extension || '').toLowerCase().replace(/^\./, '');
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
