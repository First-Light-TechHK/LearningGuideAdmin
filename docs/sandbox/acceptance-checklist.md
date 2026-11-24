# Sandbox 隔离验收清单

> 用途：Sandbox 两服务部署完成后的环境级验收。分三部分：
> - **0. 本地自检**：`node scripts/sandbox-smoke.mjs --self-test`（不联网、不调 AWS、无凭据）。
> - **A. 自动 smoke**：`node scripts/sandbox-smoke.mjs`（只发 HTTPS 请求，不调 AWS、不读密钥）。
> - **B. 手工核对**：需要 AWS 控制台 / IAM / Stripe Dashboard / 真实浏览器执行的项。
> 与 `docs/sandbox/provisioning-request.md` §5 的 Phase 4/5 对应；任何一项不过都不得宣告 Sandbox 可用。
> 能力/角色（`docs/sandbox/partitioning.md` §5）：Sandbox 全模块、全角色启用；需要密钥的功能（AI Tutor/KS、Helpdesk、邮件、Portal 集成、Study Group）已打开，密钥由运维配置，未配置时按设计降级（Helpdesk 503、AI 未配置错误）。验收按“已配置的密钥”逐项判定。

---

## 0. 本地自检（不联网）

```bash
node --check scripts/sandbox-smoke.mjs     # 语法检查（Node 22）
node scripts/sandbox-smoke.mjs --self-test # node:test 纯函数单测：信封解包 / Cookie Domain / origin 校验
```

判定：`node --check` 无输出；self-test 全部 `pass`、退出码 0。

## 0.1 前置

- 两服务已部署且 DNS active（`provisioning-request.md` §5 Phase 1–3 完成）。
- 执行机可访问两个 https origin；Node.js ≥ 22（脚本用全局 fetch / node:test）。
- 手工项需要 ops 的 AWS 只读权限与 Stripe 测试账号登录。

## A. 自动 smoke（HTTP only）

```bash
PORTAL_ORIGIN=https://<sandbox-host> \
ADMIN_ORIGIN=https://admin.<sandbox-host> \
ADMIN_SESSION_COOKIE='<员工会话 Cookie>' \
ADMIN_API_TOKEN='<Admin AUTH_TOKEN，仅本机变量，不入库>' \
EXPECTED_VERSION='<本次部署的生产发布 SHA（sandbox 分支快进目标）>' \
node scripts/sandbox-smoke.mjs
```

覆盖项与判定：

| # | 检查 | 判定 |
|---|---|---|
| A1 | Portal `GET /api/health` | 200；`environment=SANDBOX`；`ready=true`；`checks.database/paymentMigration/storage` 全 true（**注意**：`checks=null` 说明部署的 Portal 未含 Portal 工作区 D3 修复（`isManagedEnvironment()` 含 SANDBOX），脚本会标 fail；该修复待提交/部署验证） |
| A2 | Portal `GET /api/health/config` | `storage=postgresql+s3`；`payment.mode=stripe`、`configured=true`、`stripeSecret/stripeWebhook=configured`；8 个 `lookupKeys` 全 `configured`；`authentication.sessionSecret=configured`；`missing=[]` |
| A3 | Portal 首页 Set-Cookie | 探测 `${portal}/`（跟随 307 → `/en-GB/portal`）；所有 `Set-Cookie` **无 Domain 属性**（host-only）；首页未下发 Cookie 时记 **skip**（登录才下发会话 Cookie，改由 B6 手工验证） |
| A4 | Admin `GET /api/health` | 200；`service=learning-guide-admin`；`environment=SANDBOX`（响应为 `{success,data}` 信封，脚本自动解包） |
| A5 | Admin `GET /api/backoffice/environment` | 200（需员工 Cookie）；`label=Sandbox`；`versionNumberingMode=sandbox`；`stripeConfigured=true`。未提供 Cookie 时记 **skip**（改手工 B1）；**提供了 Cookie 仍被 401/403 拒绝记 fail** |
| A6 | Admin 学员端/目录 API Key 鉴权 | `GET /api/portal/v1/courses` + 假 `X-API-Key` → **401**；提供 `ADMIN_API_TOKEN` 时正确 key → 200 |
| A7 | 传输层 | 两个 origin 必须是 `https://`，否则直接 fail |
| A8 | 版本一致性 | 提供 `EXPECTED_VERSION` 时，Portal `/api/health` 的 `version` 必须与之相等（分支契约，`partitioning.md` §6）；未提供记 skip（改 B0） |

退出码 0 = 无 fail（pass + skip）；1 = 存在 fail。**存在 skip 项时，B 部分对应手工项必须完成后才能宣告 Sandbox 可用**（skip 列表会打印在脚本末尾）。

## B. 手工核对（按顺序执行）

### B0 代码一致性（分支契约，`partitioning.md` §6）

- 取最近一次生产发布（UAT=当前生产）部署的提交 SHA（`sandbox` 分支快进目标；Admin 与 Portal 各自仓库）。修复合入上游 dev 后随下一次生产发布进入 sandbox。
- Portal：`GET /api/health` 的 `version` 字段 == 该 SHA（smoke 传 `EXPECTED_VERSION=<SHA>` 自动断言）。
- Admin：`/api/health` 不返回 version，用 App Runner 部署记录/`APP_VERSION` 配置核对同一 SHA。
- `sandbox` 分支 `git rev-parse` 与该提交相等；分支上不得出现 sandbox 专属提交。

### B1 环境徽标、版本编号与能力/角色（若 A5 未跑）

- 用 Operator 账号登录 `https://admin.sandbox.ilovelearningguide.com`。
- 页头徽标为**紫色 `Sandbox`**（红色 Production 即错）。
- 课程页发布一门课 → 版本号 `1.1`；改动后再发布 → `1.2`；导出后再发布 → `2.1`（Sandbox `X.Y` 语义）。
- 能力/角色：不设 `APP_ROLES` / `ADMIN_CAPABILITIES`，全部模块菜单可见（按角色权限）；`/api/user/**`、`/api/ks/**` 已挂载但仍要求服务密钥（`AUTH_TOKEN` / `KS_SERVICE_TOKEN`）；Helpdesk 未配置令牌时 `/api/helpdesk/**` 返回 503 `HELPDESK_NOT_CONNECTED`（不是 404）；AI Tutor 入口可用，未配置 `OPENROUTER_API_KEY` 时明确提示未配置而不是崩溃。`ADMIN_ENV=sandbox` 的 provision 脚本只显式写入 `ENVIRONMENT_LABEL=Sandbox`、`VERSION_NUMBERING_MODE=sandbox`；手工部署路径需核对这两项且不要写 `APP_ROLES`/`ADMIN_CAPABILITIES`。

### B2 数据库跨环境拒绝（ops）

```bash
# 用 UAT 的应用凭据连 Sandbox DB，必须失败（隔离的硬证据）
psql "$UAT_DATABASE_URL" -c "select 1"              # 期望：连接超时/拒绝
# Sandbox 库内不得有真实学员数据
psql "$SANDBOX_DATABASE_URL" -c "select count(*) from orm_rows where domain='users'"
```

- RDS 控制台：`learning-guide-sandbox` 与 `learning-guide-admin-sandbox` 均 `PubliclyAccessible=false`、`StorageEncrypted=true`、备份保留 7 天。
- Admin 库：`SELECT extversion FROM pg_extension WHERE extname='vector';` 有值；`SELECT name FROM "CourseCatalogueEntry" WHERE "parentId" IS NULL ORDER BY "sortOrder";` 返回 `Science / Chinese Humanities / European Humanities / Society`。

### B3 对象存储跨环境拒绝（ops）

- IAM Policy Simulator：用 `learning-guide-sandbox-runtime` 模拟 `s3:GetObject` 到 UAT/DEV 桶/前缀 → **denied**；UAT 运行时角色读 sandbox 桶 → **denied**。
- S3 控制台：两个 sandbox 桶的 Block Public Access 4 项全 true、版本化 Enabled。
- `aws s3api head-object --bucket <sandbox-bucket> --key learning-guide/sandbox/.deployment-ready` 成功（Portal A1 依赖）。

### B4 密钥跨环境拒绝（ops）

- IAM Policy Simulator：sandbox 运行时角色 `secretsmanager:GetSecretValue` 到其它环境命名空间 → **denied**；反向亦然。
- `learning-guide/admin/sandbox/admin_api_key` 只被 Portal 的 `shared-admin-tokens-read` 与 Admin 运行时角色精确授权。

### B5 Stripe 隔离与 livemode（产品/ops，登录 Stripe 测试账号）

- 用测试卡在 Course Sandbox 完成一次订阅：Checkout 与事件 `livemode=false`；订单 paid；entitlement 生效。
- Dashboard：webhook endpoint 只有 `https://<sandbox-host>/api/payment/webhook`，签名密钥独立。
- 全环境排查：Sandbox 服务的 App Runner 变量/Secrets 中 grep 不到 `sk_live_`。
- 过期/取消会话不产生授权。

### B6 登录与邮件（产品）

- Google：真实登录成功；回调 `.../api/auth/google/callback` 只指向 sandbox 域名。
- WeChat：真实扫码 + 邮箱绑定；授权域只含 `sandbox.<domain>`。
- 邮箱密码注册：验证邮件真实送达；链接域名是 sandbox；验证后旧链接失效。
- `LOCAL_SOCIAL_LOGIN=0`：页面无本地账号入口。

### B7 课程内容（产品/开发）

- 测试账号在 Course Sandbox 能看到并播放课程、走试看/订阅全链路。
- **已知限制**：Portal 尚未消费 Admin 课程投影（G8）；首期验收以 Portal 数据迁移导入的同内容课程为过渡，并在记录里注明。
- 分类筛选在 Portal 显示 Admin Sandbox 的 4 个分类（`services/adminCatalogue.ts` 走 `/api/portal/v1/categories`）。
- AI Tutor：全启用；配置 `OPENROUTER_API_KEY` 后验收学员对话与后台测试对话各一次；未配置时页面明确提示“未配置可用的 LLM API Key”，不得崩溃或伪造成功（`partitioning.md` §5）。

### B8 数据重置演练（产品/ops，按 `provisioning-request.md` §7 Q5 结论执行）

- 重置测试学员（订单/订阅/权益/学习记录）后：账号可重新订阅与学习；课程内容不受影响；重置操作有审计记录。

### B9 成本与监控（ops）

- 上线 24 小时后 Cost Explorer 核对（预算参考：SIT 约 USD 80–100/月含 NAT；Sandbox 预估 USD 110–170/月 + 媒体存储）。
- 5xx/延迟/DB CPU/存储/webhook 失败告警各触发一次测试通知。

---

## C. 验收记录

| 项 | 结果 | 证据 | 执行人 | 日期 |
|---|---|---|---|---|
| 0 本地自检 | | `--self-test` TAP 输出 | | |
| A1–A8 smoke | | 脚本 JSON 输出 | | |
| B1 徽标/编号/能力角色 | | 截图 + 版本列表 + 端点探测 | | |
| B2 DB 隔离 | | psql 输出 + 控制台截图 | | |
| B3 S3 隔离 | | IAM 模拟结果 | | |
| B4 Secrets 隔离 | | IAM 模拟结果 | | |
| B5 Stripe | | Dashboard 截图 + 订单号 | | |
| B6 登录/邮件 | | 收件箱截图 | | |
| B7 课程内容 | | 播放截图 | | |
| B8 数据重置 | | 前后账号状态对比 | | |
| B9 成本/告警 | | Cost Explorer + 告警通知 | | |

> 通过标准：0 + A 全部 pass（含人工补项）、B1–B9 全部打勾（未配置密钥的功能项按说明标注“待运维配置”，其降级行为仍需验证）。任何“降级接受”须由 LEO 书面确认并记录在本文件尾部。
