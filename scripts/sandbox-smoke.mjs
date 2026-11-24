#!/usr/bin/env node
/**
 * Sandbox 隔离验收 smoke（HTTP only，不调用 AWS、不读密钥）。
 *
 * 用途：在 Sandbox 两服务部署完成后，从运维终端跑一遍环境级验收。
 * 只发 HTTPS 请求并断言可观测事实；涉及 AWS 控制台/IAM 的检查在
 * docs/sandbox/acceptance-checklist.md 里由 ops 手工执行。
 *
 * 用法（live 验收）：
 *   PORTAL_ORIGIN=https://<sandbox-host> \
 *   ADMIN_ORIGIN=https://admin.<sandbox-host> \
 *   node scripts/sandbox-smoke.mjs
 *
 * 本地自检（不联网、不调 AWS、无凭据）：
 *   node scripts/sandbox-smoke.mjs --self-test
 *   —— 以 node:test 形式跑纯函数单元测试（Admin 信封解包、Set-Cookie Domain、
 *      origin 校验），供本地与 CI 在 node --check 之后快速验证脚本本身。
 *
 * 可选环境变量：
 *   ADMIN_SESSION_COOKIE  员工会话 Cookie（用于 /api/backoffice/environment）
 *   ADMIN_API_TOKEN       Admin AUTH_TOKEN（用于正向 API Key 断言；只做比较，不打印）
 *   WRONG_API_KEY         用于断言 401 的错误密钥（缺省用固定假值）
 *   EXPECTED_VERSION      发布记录中 Sandbox 部署的上游 dev 提交 SHA：断言 Portal
 *                         /api/health 的 version 与之相等（分支契约，见
 *                         docs/sandbox/partitioning.md §6）。
 *                         Admin 不暴露 version 字段，按 acceptance-checklist B0 手工核对。
 *
 * 结果语义：pass / fail / skip。fail 才导致退出码 1；skip（如未提供
 * Cookie 或首页无 Set-Cookie）不阻塞退出码，但必须在
 * docs/sandbox/acceptance-checklist.md 的 B 部分手工补验后才能宣告 Sandbox 可用。
 *
 * 已知实现事实（与本仓库代码核对过）：
 *   - Admin 全局 TransformInterceptor 把成功响应包成
 *     {success, data, error, message}，因此 Admin 端点（/api/health、
 *     /api/backoffice/environment）要读 body.data。
 *   - Portal 根路径 / 是 307 重定向到 /en-GB/portal，首页探测需跟随重定向。
 *   - Fetch 的 getSetCookie() 返回 Array<string>，不是 Map。
 *   - 能力分区（docs/sandbox/partitioning.md §5）：Sandbox Admin 只起 admin 角色，
 *     /api/user/** 与 /api/ks/** 不对外；Helpdesk 与 AI Tutor 首期不启用，
 *     本脚本不断言这些端点。
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const TIMEOUT_MS = 15000;

/** Admin 的 TransformInterceptor 信封解包；Portal 响应原样返回。 */
export function unwrapAdminEnvelope(body) {
  if (body && typeof body === "object" && body.success === true && "data" in body) {
    return body.data;
  }
  return body;
}

/**
 * Set-Cookie 里的 Domain 属性列表（空数组 = 全部 host-only 或没有 Cookie）。
 * 纯函数，便于 --self-test 直接验证。
 */
export function cookieDomainAttributes(cookies) {
  if (!Array.isArray(cookies)) return [];
  const domains = [];
  for (const value of cookies) {
    const parts = String(value).split(";").map((s) => s.trim());
    const domainPart = parts.find((p) => p.toLowerCase().startsWith("domain="));
    if (domainPart) domains.push(domainPart.slice("domain=".length));
  }
  return domains;
}

/** 两个 origin 是否可做 live 验收（https + 可解析）。返回问题列表。 */
export function originProblems(portal, admin) {
  const problems = [];
  for (const [name, value] of [["PORTAL_ORIGIN", portal], ["ADMIN_ORIGIN", admin]]) {
    if (!/^https:\/\//i.test(value)) {
      problems.push(`${name} must be an https URL`);
      continue;
    }
    try {
      new URL(value);
    } catch {
      problems.push(`${name} is not a valid URL`);
    }
  }
  return problems;
}

function recordFactory() {
  const results = [];
  const fails = [];
  const skips = [];
  function record(name, status, detail) {
    results.push({ name, status, detail });
    if (status === "fail") fails.push(name);
    if (status === "skip") skips.push(name);
  }
  return { results, fails, skips, record };
}

/* ============================== live 验收 ============================== */

async function runLive() {
  const portal = (process.env.PORTAL_ORIGIN || "").trim().replace(/\/+$/, "");
  const admin = (process.env.ADMIN_ORIGIN || "").trim().replace(/\/+$/, "");
  const sessionCookie = (process.env.ADMIN_SESSION_COOKIE || "").trim();
  const adminToken = (process.env.ADMIN_API_TOKEN || "").trim();
  const wrongKey = (process.env.WRONG_API_KEY || "sandbox-smoke-wrong-key-not-a-secret").trim();
  const expectedVersion = (process.env.EXPECTED_VERSION || "").trim();

  const { results, fails, skips, record } = recordFactory();

  function assert(cond, name, detail) {
    record(name, cond ? "pass" : "fail", detail);
    return Boolean(cond);
  }

  function requireEnv() {
    const problems = originProblems(portal, admin);
    if (problems.length) {
      for (const problem of problems) record("env", "fail", problem);
      finish();
    }
  }

  async function get(url, { headers = {}, redirect = "follow", name = "" } = {}) {
    let response;
    let text;
    try {
      // fetch 与 body 读取都在 try 内：AbortSignal.timeout 会同时中止
      // 连接与响应体消费，SSR 页面在 header 之后才流式返回 body，
      // 超时会发生在 response.text() 而不是 fetch，两者都必须被捕获。
      response = await fetch(url, { headers, redirect, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await response.text();
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? "请求超时（连接或响应体）" : String(error?.message ?? error);
      return { response: response ?? null, body: null, text: "", error: `${name || url} ${reason}` };
    }
    let body = null;
    try { body = JSON.parse(text); } catch { /* html or empty */ }
    return { response, body, text, error: null };
  }

  /**
   * 断言 Set-Cookie 都是 host-only（无 Domain 属性），防止会话跨环境。
   * 无任何 Set-Cookie 时记 skip（登录动作才下发会话 Cookie，首页探测可能没有）。
   */
  function checkHostOnlyCookies(cookies, origin, label) {
    const host = new URL(origin).hostname;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      record(`cookie:${label}`, "skip",
        `响应未携带 Set-Cookie（${host}）——host-only 需在 B6 真实登录时手工验证`);
      return;
    }
    const domains = cookieDomainAttributes(cookies);
    if (domains.length) {
      record(`cookie:${label}`, "fail",
        `Set-Cookie 带 Domain=${domains.join(", ")}，应为 host-only（${host}）`);
      return;
    }
    record(`cookie:${label}`, "pass", `${cookies.length} 个 Set-Cookie 均为 host-only（${host}）`);
  }

  async function checkPortal() {
    // 1) 健康检查：SANDBOX 标识 + 就绪状态（Portal 响应无信封，直接读顶层）
    const health = await get(`${portal}/api/health`, { name: "portal health" });
    if (health.error) { record("portal:health", "fail", health.error); return; }
    assert(health.response.status === 200, "portal:health:200", `HTTP ${health.response.status}`);
    assert(health.body?.service === "learning-guide", "portal:health:service", `service=${health.body?.service}`);
    assert(health.body?.environment === "SANDBOX", "portal:health:env", `environment=${health.body?.environment}`);
    if (expectedVersion) {
      assert(health.body?.version === expectedVersion, "portal:health:version",
        `version=${health.body?.version}（期望 ${expectedVersion}：sandbox 分支应快进到上游 dev 同一提交，见 docs/sandbox/partitioning.md §6）`);
    } else {
      record("portal:health:version", "skip", "未提供 EXPECTED_VERSION，代码一致性按 acceptance-checklist B0 手工核对");
    }
    if (health.body && typeof health.body.ready === "boolean") {
      assert(health.body.ready === true, "portal:health:ready", `ready=${health.body.ready}`);
    } else {
      record("portal:health:ready", "fail", "响应缺少 ready 字段");
    }
    // 已知风险：Portal isManagedEnvironment() 未含 SANDBOX 时 checks 为 null（ready 恒真）。
    if (health.body && health.body.checks === null) {
      record("portal:health:checks", "fail",
        "checks=null：Portal isManagedEnvironment() 尚未把 SANDBOX 视为受管环境，DB/S3 检查未执行（docs/sandbox/environments.md §6 D3）");
    } else if (health.body?.checks) {
      for (const [k, v] of Object.entries(health.body.checks)) {
        assert(v === true, `portal:health:checks:${k}`, `${k}=${v}`);
      }
    }

    // 2) 配置自检：存储/支付/登录/邮件逐项
    const config = await get(`${portal}/api/health/config`, { name: "portal config" });
    if (config.error) { record("portal:config", "fail", config.error); return; }
    assert(config.response.status === 200, "portal:config:200", `HTTP ${config.response.status}`);
    if (config.body) {
      assert(config.body.storage === "postgresql+s3", "portal:config:storage", `storage=${config.body.storage}`);
      assert(config.body.payment?.mode === "stripe", "portal:config:payment-mode", `mode=${config.body.payment?.mode}`);
      assert(config.body.payment?.configured === true, "portal:config:payment-configured", `configured=${config.body.payment?.configured}`);
      assert(config.body.payment?.stripeSecret === "configured", "portal:config:stripe-secret", `stripeSecret=${config.body.payment?.stripeSecret}`);
      assert(config.body.payment?.stripeWebhook === "configured", "portal:config:stripe-webhook", `stripeWebhook=${config.body.payment?.stripeWebhook}`);
      const keys = config.body.payment?.lookupKeys || {};
      const missingKeys = Object.entries(keys).filter(([, v]) => v !== "configured").map(([k]) => k);
      assert(missingKeys.length === 0, "portal:config:stripe-lookup-keys",
        missingKeys.length === 0 ? "8 个价格 Lookup Key 全部 configured" : `未配置：${missingKeys.join(", ")}`);
      assert(config.body.authentication?.sessionSecret === "configured", "portal:config:session-secret", `sessionSecret=${config.body.authentication?.sessionSecret}`);
      assert(config.body.missing?.length === 0, "portal:config:missing-empty", `missing=${JSON.stringify(config.body.missing)}`);
    } else {
      record("portal:config:body", "fail", "响应不是 JSON");
    }

    // 3) 首页跟随重定向（/ → 307 → /en-GB/portal），检查 Set-Cookie host-only
    const home = await get(`${portal}/`, { name: "portal home" });
    if (home.error) { record("portal:home", "fail", home.error); return; }
    assert(home.response.status === 200, "portal:home:200", `HTTP ${home.response.status}（已跟随重定向）`);
    checkHostOnlyCookies(home.response.headers.getSetCookie?.() ?? [], portal, "portal");
  }

  async function checkAdmin() {
    // 4) Admin 健康检查（响应是 {success, data} 信封，读 data）
    const health = await get(`${admin}/api/health`, { name: "admin health" });
    if (health.error) { record("admin:health", "fail", health.error); return; }
    const healthData = unwrapAdminEnvelope(health.body);
    assert(health.response.status === 200, "admin:health:200", `HTTP ${health.response.status}`);
    assert(healthData?.service === "learning-guide-admin", "admin:health:service", `service=${healthData?.service}`);
    assert(healthData?.environment === "SANDBOX", "admin:health:env", `environment=${healthData?.environment}`);

    // 5) 环境徽标与版本编号模式（需要员工会话；无 Cookie 时记 skip，由 B1 手工补验）
    const envInfo = await get(`${admin}/api/backoffice/environment`, {
      name: "admin environment",
      headers: sessionCookie ? { Cookie: sessionCookie } : {},
    });
    if (envInfo.error) { record("admin:env", "fail", envInfo.error); return; }
    if (envInfo.response.status === 401 || envInfo.response.status === 403) {
      if (sessionCookie) {
        // 提供了 Cookie 仍被拒：过期/失效/账号禁用——这是真实失败，不能伪装成 skip。
        record("admin:env", "fail",
          `HTTP ${envInfo.response.status}：提供的 ADMIN_SESSION_COOKIE 被 Admin 拒绝（过期/失效/账号禁用），请重新登录后重跑`);
      } else {
        record("admin:env", "skip",
          `HTTP ${envInfo.response.status}：未提供 ADMIN_SESSION_COOKIE——按 acceptance-checklist.md B1 手工核对（label=Sandbox、versionNumberingMode=sandbox、stripeConfigured=true）`);
      }
    } else {
      const envData = unwrapAdminEnvelope(envInfo.body);
      assert(envInfo.response.status === 200, "admin:env:200", `HTTP ${envInfo.response.status}`);
      assert(envData?.label === "Sandbox", "admin:env:label", `label=${envData?.label}`);
      assert(envData?.versionNumberingMode === "sandbox", "admin:env:numbering", `versionNumberingMode=${envData?.versionNumberingMode}`);
      assert(envData?.stripeConfigured === true, "admin:env:stripe", `stripeConfigured=${envData?.stripeConfigured}`);
    }

    // 6) 服务 API Key 鉴权：错误 key → 401（服务鉴权隔离的 HTTP 侧证据）
    const wrong = await get(`${admin}/api/portal/v1/courses`, { name: "admin wrong key", headers: { "X-API-Key": wrongKey } });
    if (wrong.error) { record("admin:auth", "fail", wrong.error); return; }
    assert(wrong.response.status === 401, "admin:auth:wrong-key-401", `HTTP ${wrong.response.status}（X-API-Key=假值）`);
    if (adminToken) {
      const right = await get(`${admin}/api/portal/v1/courses`, { name: "admin right key", headers: { "X-API-Key": adminToken } });
      if (right.error) { record("admin:auth:right-key", "fail", right.error); return; }
      assert(right.response.status === 200, "admin:auth:right-key-200", `HTTP ${right.response.status}`);
    } else {
      record("admin:auth:right-key", "skip", "未提供 ADMIN_API_TOKEN，正向断言跳过（手工确认 Portal 用正确 key 能 200）");
    }
  }

  function finish() {
    const summary = {
      ok: fails.length === 0,
      pass: results.filter((r) => r.status === "pass").length,
      fail: fails.length,
      skip: skips.length,
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (skips.length) {
      console.error(`注意：${skips.length} 项 skip（${skips.join(", ")}）——按 docs/sandbox/acceptance-checklist.md 的 B 部分手工补验后才能宣告 Sandbox 可用。`);
    }
    process.exit(fails.length === 0 ? 0 : 1);
  }

  requireEnv();
  await checkPortal();
  await checkAdmin();
  finish();
}

/* ============================== 本地自检 ============================== */

async function runSelfTest() {
  const { test } = await import("node:test");
  const assert = (await import("node:assert/strict")).default;

  test("unwrapAdminEnvelope unwraps the Admin {success,data} envelope", () => {
    assert.deepEqual(
      unwrapAdminEnvelope({ success: true, data: { label: "Sandbox" }, error: null }),
      { label: "Sandbox" },
    );
  });

  test("unwrapAdminEnvelope passes plain bodies through", () => {
    const plain = { service: "learning-guide", environment: "SANDBOX" };
    assert.equal(unwrapAdminEnvelope(plain), plain);
    assert.equal(unwrapAdminEnvelope(null), null);
    // success=false 的错误响应不能被当成成功信封解包
    const error = { success: false, data: null, error: { code: "X" } };
    assert.equal(unwrapAdminEnvelope(error), error);
  });

  test("cookieDomainAttributes accepts host-only cookies", () => {
    assert.deepEqual(cookieDomainAttributes(["sid=abc; Path=/; HttpOnly; Secure"]), []);
    assert.deepEqual(cookieDomainAttributes([]), []);
  });

  test("cookieDomainAttributes flags Domain attributes regardless of case", () => {
    assert.deepEqual(
      cookieDomainAttributes(["sid=abc; Domain=.ilovelearningguide.com; Path=/"]),
      [".ilovelearningguide.com"],
    );
    assert.deepEqual(
      cookieDomainAttributes(["a=1; domain=sandbox.ilovelearningguide.com", "b=2; Path=/"]),
      ["sandbox.ilovelearningguide.com"],
    );
  });

  test("originProblems requires https origins", () => {
    assert.deepEqual(originProblems("https://sandbox.example.com", "https://admin.sandbox.example.com"), []);
    assert.equal(originProblems("http://sandbox.example.com", "https://admin.example.com").length, 1);
    assert.equal(originProblems("", "").length, 2);
    assert.equal(originProblems("https://ok.example.com", "not-a-url").length, 1);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
const isEntrypoint = invokedPath === import.meta.url;

if (isEntrypoint && process.argv.includes("--self-test")) {
  await runSelfTest();
} else if (isEntrypoint) {
  await runLive();
}
