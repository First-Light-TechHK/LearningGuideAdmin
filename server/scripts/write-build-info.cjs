const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const supplied = (process.env.BUILD_COMMIT || '').trim();
if (supplied && !/^[0-9a-f]{40}$/.test(supplied)) throw new Error('BUILD_COMMIT must be a lowercase full 40-character commit SHA');
let gitCommit = null;
let dirty = false;
try {
  gitCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
} catch { /* Source archives and Docker builds may omit .git. */ }
if (gitCommit) {
  // Fail closed if worktree status cannot be established, including untracked source.
  dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim().length > 0;
}
if (supplied && gitCommit && (supplied !== gitCommit || dirty)) throw new Error('BUILD_COMMIT must match a clean checked-out commit');
const buildCommit = supplied || (!dirty && /^[0-9a-f]{40}$/.test(gitCommit || '') ? gitCommit : null);
fs.mkdirSync('dist', {recursive:true});
fs.writeFileSync(path.join('dist','build-info.json'), JSON.stringify({buildCommit})+'\n');
