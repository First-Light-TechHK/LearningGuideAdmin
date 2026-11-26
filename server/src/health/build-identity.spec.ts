import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('build-time identity artifact', () => {
  it('writes the supplied full SHA, rejects malformed input, and uses null when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lg-build-stamp-'));
    const script = resolve('scripts/write-build-info.cjs');
    const run = (commit: string) => spawnSync(process.execPath, [script], {cwd:dir, env:{...process.env, BUILD_COMMIT:commit}});
    try {
      expect(run('a'.repeat(40)).status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir,'dist/build-info.json'),'utf8'))).toEqual({buildCommit:'a'.repeat(40)});
      expect(run('abcdef').status).not.toBe(0);
      expect(run('').status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir,'dist/build-info.json'),'utf8'))).toEqual({buildCommit:null});
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
