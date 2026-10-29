import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The server needs Node >= 22.19 (pi-agent-core / pi-ai, helpdesk-agent-v2-pi-dsh). The setup
// scripts and the README must ask for the same minimum as server/package.json "engines".
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const engines = JSON.parse(read("server/package.json")).engines.node;
const [, major, minor] = /^>=(\d+)\.(\d+)\.0$/.exec(engines) ?? [];

test("server engines name a major.minor minimum", () => {
  assert.equal(engines, ">=22.19.0");
});

test("setup.sh checks the server minimum", () => {
  const sh = read("setup.sh");
  assert.match(sh, new RegExp(`\\nMIN_NODE_MAJOR=${major}\\n`));
  assert.match(sh, new RegExp(`\\nMIN_NODE_MINOR=${minor}\\n`));
});

test("setup.ps1 checks the server minimum", () => {
  const ps = read("setup.ps1");
  assert.match(ps, new RegExp(`\\n\\$MinNodeMajor = ${major}\\r?\\n`));
  assert.match(ps, new RegExp(`\\n\\$MinNodeMinor = ${minor}\\r?\\n`));
});

test("the README states the same minimum", () => {
  assert.match(read("README.md"), new RegExp(`Node\\.js ≥ ${major}\\.${minor}（`));
});

// pi is ESM loaded with a real import(): Jest only allows that under --experimental-vm-modules.
test("every server script that runs Jest passes --experimental-vm-modules", () => {
  const scripts = JSON.parse(read("server/package.json")).scripts;
  const jest = Object.entries(scripts).filter(([, command]) => /\bjest\b/.test(command));
  assert.ok(jest.length >= 5, "test, test:watch, test:cov, test:debug, test:e2e");
  for (const [name, command] of jest) {
    assert.match(command, /^node (--\S+ )*--experimental-vm-modules /, name);
    assert.match(command, /node_modules\/jest\/bin\/jest\.js/, name);
  }
});
