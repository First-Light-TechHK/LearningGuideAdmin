import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read build-time identity only; runtime environment variables are not evidence. */
export function readBuildCommit(file = join(__dirname, '..', 'build-info.json')): string | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { buildCommit?: unknown };
    return typeof data.buildCommit === 'string' && /^[0-9a-f]{40}$/.test(data.buildCommit) ? data.buildCommit : null;
  } catch { return null; }
}
