import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Owner 2026-11-24: Sandbox no longer partitions modules or roles. Every module is
// open, including key-gated ones; missing keys degrade by design (Helpdesk 503,
// AI endpoints unavailable) until ops configures them.
//
// server/src/common/capabilities.ts and app-roles.ts define the contract:
// an unset/empty ADMIN_CAPABILITIES means ALL capabilities, and an unset/empty
// APP_ROLES starts admin, agent and ks. Sandbox must therefore leave both unset
// instead of listing them explicitly (explicit lists would silently keep future
// modules closed).
const envTemplate = readFileSync(
  new URL("../deploy/sandbox.example.env", import.meta.url),
  "utf8",
);
const provision = readFileSync(
  new URL("./provision-admin-dev.mjs", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../deploy/admin-sandbox-deploy.yml.template", import.meta.url),
  "utf8",
);

/** The active (uncommented) assignment for KEY, or null. */
function activeAssignment(text, key) {
  return new RegExp(`^${key}=.*$`, "m").exec(text)?.[0] ?? null;
}

test("sandbox env template leaves capabilities and roles unrestricted", () => {
  assert.equal(
    activeAssignment(envTemplate, "ADMIN_CAPABILITIES"),
    null,
    "ADMIN_CAPABILITIES must stay unset: unset means every module is enabled",
  );
  assert.equal(
    activeAssignment(envTemplate, "APP_ROLES"),
    null,
    "APP_ROLES must stay unset: unset starts admin, agent and ks",
  );
});

test("sandbox provisioning does not write capability or role restrictions", () => {
  const block =
    /const sandboxEnvironmentDefaults = \{([\s\S]*?)\};/.exec(provision)?.[1] ??
    "";
  assert.ok(block, "sandboxEnvironmentDefaults block missing");
  assert.doesNotMatch(block, /APP_ROLES/);
  assert.doesNotMatch(block, /ADMIN_CAPABILITIES/);
  assert.match(block, /ENVIRONMENT_LABEL: "Sandbox"/);
  assert.match(block, /VERSION_NUMBERING_MODE: "sandbox"/);
});

test("sandbox env template points partner addresses at the sandbox and keeps keys as references", () => {
  assert.match(
    envTemplate,
    /^KS_TUTOR_BASE_URL=https:\/\/<admin-sandbox-host>/m,
    "Portal must call the Sandbox Admin learner API",
  );
  assert.match(
    envTemplate,
    /^OPENROUTER_BASE_URL=https:\/\/openrouter\.ai\/api\/v1/m,
  );
  assert.match(
    envTemplate,
    /^PORTAL_HELPDESK_BASE_URL=https:\/\/<sandbox-host>/m,
  );
  // Secrets stay Secret Manager references; never inline fake provider keys.
  assert.match(envTemplate, /OPENROUTER_API_KEY=<secret-ref:/);
  assert.doesNotMatch(envTemplate, /sk-or-/);
});

test("sandbox deploy workflow documents key-gated modules as open with designed degradation", () => {
  assert.doesNotMatch(workflow, /首期不启用\s*AI Tutor/);
  assert.doesNotMatch(workflow, /沙箱首期 AI 不启用/);
  // AI secrets stay optional: the step skips until ops configures the ARNs.
  assert.match(
    workflow,
    /if: vars\.SANDBOX_OPENROUTER_API_KEY_SECRET_ARN != '' \|\| vars\.SANDBOX_AI_CONFIG_ENCRYPTION_KEY_SECRET_ARN != ''/,
  );
});
