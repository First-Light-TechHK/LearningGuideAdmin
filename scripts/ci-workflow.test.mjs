import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// CI must actually run the HelpDesk suites: the client node:test files and the server
// PostgreSQL specs (they skip without HELPDESK_TEST_DATABASE_URL). Job names stay as they
// are because dev-deploy.yml waits for the "CI" workflow and branch protection names them.
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

/** The text of one job: from "  <id>:" up to the next job at the same indent. */
function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `job ${id} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("job names are unchanged", () => {
  assert.match(job("server"), /\n {4}name: Server build and test\n/);
  assert.match(job("client"), /\n {4}name: Client build\n/);
});

test("the client job runs the client tests after the build", () => {
  const client = job("client");
  const build = client.indexOf("- run: npm run build");
  const tests = client.indexOf("- run: npm test");
  assert.ok(build > 0, "client build step missing");
  assert.ok(tests > build, "client job must run npm test after npm run build");
});

test("the server job runs the HelpDesk PostgreSQL specs against a postgres service", () => {
  const server = job("server");
  assert.match(server, /\n {4}services:\n {6}postgres:\n {8}image: postgres:16\n/);
  assert.match(server, /--health-cmd pg_isready/);
  assert.match(server, /- 5432:5432/);
  const step = server.slice(server.indexOf("- run: npm test -- --runInBand"));
  assert.match(
    step,
    /^- run: npm test -- --runInBand --passWithNoTests\n {8}env:\n {10}HELPDESK_TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/helpdesk_test\n/,
  );
  assert.match(server, /POSTGRES_DB: helpdesk_test/);
});

// v5 Part G5: a free gate (no model, no key) for the data flywheel. It runs the retrieval-only
// eval over the FAQ library and the accepted regression cases (recall@8 >= 95%), the guard
// corpus (answers and gap labels) and the PII scrubber corpus shared with Portal, with CI=true
// so a missing database fails instead of skipping.
test("the HelpDesk eval gate job runs the free retrieval, guard and scrubber corpus specs against postgres", () => {
  const gate = job("helpdesk-eval");
  assert.match(gate, /\n {4}name: HelpDesk eval gate\n/);
  assert.match(gate, /\n {4}services:\n {6}postgres:\n {8}image: postgres:16\n/);
  for (const spec of [
    "src/backoffice/tests/helpdesk-eval-gate.pg.spec.ts",
    "src/ai/helpdesk/workflow/guard.spec.ts",
    "src/ai/helpdesk/flywheel/gap-labeller.spec.ts",
    "src/backoffice/tests/helpdesk-pii-corpus.spec.ts",
  ])
    assert.ok(gate.includes(spec), `${spec} missing from the eval gate`);
  assert.match(gate, /CI: "true"/);
  assert.match(
    gate,
    /HELPDESK_TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/helpdesk_test/,
  );
  // free: never a model key in this job
  assert.doesNotMatch(gate, /OPENROUTER_API_KEY|secrets\./);
});
