# 机器与资源申请单 — Learning Guide Sandbox

| 字段 | 内容 |
|---|---|
| 版本 | v1.2（2026-11-19 按 Admin `feat/sandbox-provisioning` 基线 87e0be2 核对；同日按最终复验 F3b/F4/F5/F7/F9 修订） |
| 状态 | 待 ops / 产品评审；§2 可直接作为申请单 |
| 范围 | Sandbox = Course Sandbox（Portal 前台）+ Admin Sandbox（后台）+ Stripe 沙盒；按 PRD v2.0 §3.1 |
| 配套模板 | `deploy/sandbox.example.env`（仅占位符）、`deploy/sandbox-infrastructure.yml`（Portal 侧网络/DB/桶/角色）、`deploy/admin-sandbox-deploy.yml.template`、`deploy/portal-sandbox-deploy.yml.template`（Portal 工作流）、`deploy/ci-iam-policy.json.template` |
| 配套文档 | `docs/sandbox/aws-readiness.md`（Day-0 执行手册）、`docs/sandbox/ops-request-draft.md`（申请邮件/工单草稿）、`docs/sandbox/review-findings.md`（R1–R21 追溯） |
| 验收 | `scripts/sandbox-smoke.mjs`（HTTP only）+ `docs/sandbox/acceptance-checklist.md`（手工项） |
| 分区规范 | `docs/sandbox/partitioning.md`；环境矩阵 `docs/sandbox/environments.md` |

> **红线声明**：本文件由仓库代码与部署文件盘点生成。编制过程**未调用任何 AWS API、未创建任何 AWS 资源、未使用 First-Light-TechHK 账号的凭据、未提交任何真实密钥**。文中密钥一律为 Secrets Manager 引用名或 `<占位符>`；资源申请与创建由 ops 按本清单执行。

---

## 1. 环境模型（申请前共识）

- **Sandbox 的组成**（PRD v2.0 §3.1）：Course Sandbox（Portal 学员前台）+ Admin Sandbox（后台）+ Stripe 沙盒。数据与 Production 完全隔离。
- **独立部署**（owner 2026-11-16）：独立库/桶/密钥命名空间；环境差异只由配置表达，**禁止环境专属代码分支**（分区规范见 `docs/sandbox/partitioning.md`）。
- **分支契约**：`sandbox` 分支 = 上游最近一次生产发布 SHA 快进（UAT=当前生产，同码）；生产发布后快进到该发布 SHA，修复合入上游 `dev` 后随下一次生产发布进入（`docs/sandbox/environments.md` §3）。
- **能力/角色**（owner 2026-11-16 拍板、2026-11-24 修订）：Sandbox Admin 全模块、全角色（不设置 `ADMIN_CAPABILITIES` / `APP_ROLES`）；需要密钥的功能（AI Tutor/KS、Helpdesk、邮件、Portal 集成、Study Group）同样启用，密钥/ARN 由运维配置，未配置时按设计降级（Helpdesk 503、AI 未配置错误）。仍不新增编辑能力。
- **当前生产 = UAT**（课程直接发到 UAT）。Sandbox 建成后目标流程：Sandbox 创作/验证（`X.Y`）→ 导出课程包 → UAT（=Production）导入 → Publish（`Version N`）→ Change status。Production 只通过课程包获得内容（操作规则；服务端强制见 §6 G1/G2）。
- **同一套代码，仅配置不同**：`ENVIRONMENT_LABEL`、`VERSION_NUMBERING_MODE`、站点地址、Stripe key、数据库/S3/密钥命名空间、能力开关。Portal 与 Admin 各一个 App Runner 服务。

**建议拓扑（ap-southeast-1）**

```text
 sandbox.ilovelearningguide.com          admin.sandbox.ilovelearningguide.com
        │                                          │
 ┌──────▼───────────────────┐            ┌─────────▼────────────────────┐
 │ App Runner               │  X-API-Key │ App Runner                   │
 │ learning-guide-sandbox   │ ─────────► │ learning-guide-admin-sandbox │
 │ (Portal, :8080)          │ ◄───────── │ (Admin, :3000; 全角色/全模块)  │
 ├──────────────────────────┤            ├──────────────────────────────┤
 │ RDS learning-guide-      │            │ RDS learning-guide-admin-     │
 │ sandbox (PostgreSQL 16)  │            │ sandbox (PostgreSQL 16+pgvector)│
 │ S3 learning-guide-       │            │ S3 learning-guide-admin-      │
 │ sandbox-<acct>           │            │ sandbox-course-<acct>         │
 │ Secrets learning-guide/  │            │ Secrets learning-guide/admin/ │
 │ sandbox/*                │            │ sandbox/*                     │
 └──────────┬───────────────┘            └──────────┬───────────────────┘
            └────────────────┬───────────────────────┘
                             │ Stripe 测试模式（sk_test_…，livemode=false）
                       Stripe Sandbox
```

---

## 2. 申请资源清单

> 归属/申请方：**ops-AWS** = AWS 平台运维；**security** = 密钥与 IAM；**eng** = 代码/脚本/工作流；**product** = 外部账号与业务决策；**DNS** = 域名持有方（DNSPod）。
> 命名统一带 `sandbox`（规则见 `docs/sandbox/partitioning.md` §2）；AWS 账号归属未定（见 §7 Q1），先按“现有账号内独立 CloudFormation 栈”编制。

### 2.1 Portal Sandbox（Course Sandbox 前台）

| # | 资源 | 用途 | 归属 | 配置项占位 | 隔离要求 | 验收检查 |
|---|---|---|---|---|---|---|
| P1 | VPC 私有子网 ×2 | 应用与 RDS 互访/出网 | ops-AWS | 复用现有 VPC `<VPC_ID>`；`172.31.68.0/24`、`172.31.69.0/24`（SIT 64/65、UAT 66/67，核对不冲突）；`MapPublicIpOnLaunch=false` | 不与 SIT/UAT 子网重叠；DB 5432 只接受应用 SG | `describe-subnets` available；路由正确 |
| P2 | NAT Gateway + EIP + 路由表 | 容器出站 HTTPS/邮件 | ops-AWS | 1 个 NAT（与 Admin Sandbox 共用）；`0.0.0.0/0 → NAT` | 不开放入站；与其它环境 NAT 分离 | NAT available；EIP 已关联 |
| P3 | S3 Gateway Endpoint | 免 NAT 访问 S3 | ops-AWS | `com.amazonaws.ap-southeast-1.s3`，挂到 P2 路由表 | 仅本栈路由表 | Endpoint available |
| P4 | 安全组 App / DB | 出站与数据库入站 | ops-AWS | App：443/465 出站 + 5432 → VPC；DB：5432 仅来自 App SG | DB 不对公网开放 | 规则逐条核对 |
| P5 | RDS `learning-guide-sandbox` | Portal 业务库 | ops-AWS | PostgreSQL 16.13；`db.t4g.micro`；20 GiB gp3；加密；备份 7 天；`PubliclyAccessible=false`；库名 `learning_guide_sandbox`；账号 `lg_sandbox_admin`（应用账号 `lg_sandbox_app`）；`DeletionPolicy=Snapshot` | 独立实例/账号；不得与 SIT/UAT 共库 | available；私有；加密；7 天 PITR |
| P6 | S3 桶 `learning-guide-sandbox-<ACCOUNT_ID>` | 头像/资料/学习数据对象 | ops-AWS | 私有；Block Public Access 全开；SSE AES256；版本化；前缀 `learning-guide/sandbox`；非当前版本 30 天过期；`Retain` | 运行时 IAM 只允许 `learning-guide/sandbox/*`；不可读其它环境桶 | 4 项公共访问块全 true；越权前缀 AccessDenied |
| P7 | IAM 角色 `learning-guide-sandbox-runtime` | App Runner 实例角色 | security | 读 `learning-guide/sandbox/*`；本桶 Get/Put/Delete + List（限前缀）；SES Send（可选）；`shared-admin-tokens-read` 精确授权读 `learning-guide/admin/sandbox/admin_api_key` | 资源精确到 sandbox 命名空间 | IAM 模拟：读 UAT secret/bucket → denied |
| P8 | Secrets `learning-guide/sandbox/*` | Portal 密钥 | security | 见 §3.1 / §3.4 | 一环境一命名空间 | 每个 ARN 存在；值不在仓库/日志 |
| P9 | App Runner `learning-guide-sandbox` | Portal 服务 | ops-AWS + eng | Node.js 22 源码部署；构建 `npm ci && npm run build`；启动 `npm run start -- -p 8080`；端口 8080；1 vCPU / 2 GiB；健康检查 `/api/health` | 独立服务；`AutoDeploymentsEnabled=false` | RUNNING；`/api/health` 200 且 `environment=SANDBOX` |
| P10 | AutoScaling `learning-guide-sandbox` | 实例伸缩 | ops-AWS | Min 1 / Max 2 / MaxConcurrency 50 | 与其它环境分开 | 配置生效 |
| P11 | 自定义域名 `sandbox.ilovelearningguide.com` | 学员前台域名 | product + DNS | App Runner 自定义域名；按 `describe-custom-domains` 输出 CNAME/验证记录；HTTPS | 独立主机名；Cookie host-only | 域名 active；`curl https://.../api/health` 200；TLS 有效 |
| P12 | CloudWatch 日志与告警 | 运行监控 | ops-AWS | 日志 30 天；5xx、延迟、DB CPU/存储、webhook 失败告警 | 不记录密码/卡号/OAuth code | 告警存在且可触发 |
| P13 | GitHub Connection | 源码部署 | 复用现有 | 复用现有 App Runner GitHub connection | — | 连接 available |

### 2.2 Admin Sandbox（后台；全模块、全角色启用）

| # | 资源 | 用途 | 归属 | 配置项占位 | 隔离要求 | 验收检查 |
|---|---|---|---|---|---|---|
| A1 | RDS `learning-guide-admin-sandbox` | 后台数据库 | ops-AWS | PostgreSQL 16.13；`db.t4g.micro`；20 GiB gp3；加密；私有；库名 `learning_guide_admin_sandbox`；账号 `lg_admin_sandbox`；备份 7 天（provision 脚本已按 sandbox 设 7 天） | 独立实例；与 Portal Sandbox DB 及任何生产库分离 | available；私有；加密；`vector` 扩展存在 |
| A2 | S3 桶 `learning-guide-admin-sandbox-course-<ACCOUNT_ID>` | 课程媒体 + 课程包 staging | ops-AWS | 私有；公共访问块全开；SSE AES256；版本化；媒体在根前缀，包 staging 在 `staging/`；`Retain` | 运行时只读写本桶；生产导入靠操作员上传包文件，不做跨环境桶授权 | 桶策略拒绝非 TLS；角色可 Put/Get/List |
| A3 | IAM 角色 `learning-guide-admin-sandbox-runtime` | App Runner 实例角色 | security | Secrets `learning-guide/admin/sandbox/*`；S3 本桶读写；SES Send（可选）。Helpdesk/Portal 集成已启用；`learning-guide/sandbox/` 下的配对令牌在运维创建后按需精确授权（未配置时对应接口按设计 503） | 资源精确到 sandbox | IAM 模拟：读生产 secret/bucket → denied |
| A4 | Secrets `learning-guide/admin/sandbox/*` | Admin 密钥 | security | 见 §3.2 / §3.4；`admin_api_key` 部署时映射为 `AUTH_TOKEN` | 独立命名空间 | ARN 存在；与 Portal 配对值一致（§3.3） |
| A5 | App Runner `learning-guide-admin-sandbox` | 后台服务 | ops-AWS + eng | Node.js 22；构建 `cd server && npm ci && npx prisma generate && npm run build && cd ../client && npm ci && npm run build`；启动 `sh ./start-admin.sh`；端口 3000；1 vCPU / 2 GiB；健康检查 `/api/health`；`AutoDeploymentsEnabled=false`（provision 脚本对 sandbox 已关闭，发布只走工作流） | 独立服务 | RUNNING；`/api/health` 200 且 `environment=SANDBOX`；`prisma migrate deploy` 成功 |
| A6 | 自定义域名 `admin.sandbox.ilovelearningguide.com` | 后台域名 | product + DNS | App Runner 自定义域名 + HTTPS；CloudFront 可选（首期可省） | 独立主机名 | active；TLS 有效；可登录 |
| A7 | CloudFront（可选） | 后台边缘 | ops-AWS | 复用 DEV 模式（OAC + 禁缓存 + `Managed-AllViewerExceptHostHeader`） | 源站为 sandbox App Runner 域名 | deployed；回源 200 |

### 2.3 外部服务、域名与账号

| # | 资源 | 用途 | 归属 | 配置项占位 | 隔离要求 | 验收检查 |
|---|---|---|---|---|---|---|
| E1 | Stripe 测试账号（或现有测试账号内独立产品/价格） | Sandbox 订阅与支付 | product + finance | 8 个 USD 订阅价格（Six months / Year × Everything + 3 Category）；Lookup Key；`sk_test_…`；专用 webhook `https://sandbox.ilovelearningguide.com/api/payment/webhook`，事件：checkout.session.completed / async_payment_succeeded / async_payment_failed / expired / invoice.paid / invoice.payment_failed / customer.subscription.updated / deleted | **禁止 live key**；独立 webhook 签名密钥 | 8 个价格 active；Checkout `livemode=false`；webhook 验签通过 |
| E2 | Google OAuth Web Client | Google 登录 | product | Redirect URI：`https://sandbox.ilovelearningguide.com/api/auth/google/callback` | 独立回调域名 | OAuth 预检通过；真实登录成功 |
| E3 | WeChat 网站应用 | 微信扫码登录 | product | 独立网站应用；授权回调域：`sandbox.ilovelearningguide.com`（仅主机名） | 独立 AppID；openid 按 AppID 隔离 | 真实扫码 + 邮箱绑定通过 |
| E4 | 邮件通道 | 注册验证/密码重置/通知 | ops + product | 首期复用 163 SMTP（`smtp.163.com:465`，From `learningguide@163.com`）或新邮箱；`SMTP_PASS` 只进 Secrets Manager | 共用邮箱建议主题加 `[Sandbox]`（§7 Q4） | 真实收件箱收到验证邮件；链接指向 sandbox 域名 |
| E5 | OpenRouter API Key | AI Tutor | product + ops | **启用（需密钥）**：由产品/运维提供，直接注入 Secrets Manager（Portal `learning-guide/sandbox/openrouter_api_key`、Admin `learning-guide/admin/sandbox/openrouter_api_key`）；未配置时 AI 端点返回未配置错误 | 值只进 Secrets Manager | 配置后后台测试对话与学员对话可用 |
| E6 | DNS 记录 | 两个域名解析 | DNS（DNSPod） | 按 App Runner 输出添加 CNAME/验证记录 | 独立子域；不与 www/sit/uat 冲突 | `dig` 正确；HTTPS 可访问 |
| E7 | Sandbox 测试账号 | 客户角色前台测试 | product | 每个客户角色至少 1 个；可订阅（测试卡）与学习；可重置学习数据（PRD §3.2） | 账号只存在于 Sandbox | 登录/订阅/学习/重置全流程通过 |

### 2.4 软件与仓库侧

| # | 事项 | 归属 | 说明 | 验收 |
|---|---|---|---|---|
| S1 | `sandbox` 分支策略 | eng + product | `sandbox` 分支只允许快进到上游最近一次生产发布（UAT=当前生产）的 SHA；Sandbox 不走 DEV→SIT→UAT 链；修复合入上游 dev 后随下一次生产发布进入（§3 分支契约） | `git rev-parse sandbox` 与生产发布 SHA 一致 |
| S2 | Admin provision 支持 sandbox | eng | **本分支已完成**：`ADMIN_ENV=sandbox`（分支必传、`AUTH_ENABLED=true` 强制、`AUTH_TOKEN` 映射、`-sandbox-` 桶名、备份 7 天、关闭自动部署；只显式写入 `ENVIRONMENT_LABEL=Sandbox`、`VERSION_NUMBERING_MODE=sandbox`，**不写 `APP_ROLES`/`ADMIN_CAPABILITIES`** = 全角色、全模块）；脚本不自建运行时角色与课程桶 | dry-run 输出 sandbox 资源名与 `runtimeEnvironmentDefaults`（`ADMIN_BRANCH`/`AUTH_ENABLED` 校验生效） |
| S3 | Portal provision sandbox | eng（Portal 仓库） | **Portal 工作区已实现**（待提交/部署验证）：`scripts/provision-uat.mjs` 参数化 sandbox tier（`PORTAL_ENV=sandbox`，G7） | `--deploy` 可创建 `learning-guide-sandbox`；证据：Portal 工作区 `scripts/provision-uat.mjs:66-111` |
| S4 | Admin sandbox 部署工作流 | eng | **模板已提供**：`deploy/admin-sandbox-deploy.yml.template`（复制到 `.github/workflows/sandbox-deploy.yml`；手动/推送触发 + CI 门禁 + 轮询 Operation） | 发布成功且等待 `SUCCEEDED` |
| S5 | Portal sandbox 部署工作流 | eng（Portal 仓库） | **模板已提供**：`deploy/portal-sandbox-deploy.yml.template`（复制到 Portal 仓库 `.github/workflows/sandbox-deploy.yml`）；`release/environments.mjs` 的 SANDBOX 条目（D10）已在 Portal 工作区实现（待提交/部署验证） | 同上 |
| S6 | 测试账号 seed / 学习数据重置脚本 | eng（Portal 仓库） | Portal 无现成脚本；参考 `deploy/uat-acceptance-fixture.cjs`（G9） | 可重复执行；重置后可重新购买/学习 |

---

## 3. 环境变量与密钥

完整模板见 `deploy/sandbox.example.env`（只含占位符，含全模块/全角色与未配置密钥的降级说明）。此处只列引用名。

### 3.1 Portal Sandbox（App Runner 变量 / Secrets）

- 普通变量：`APP_ENV=SANDBOX`、`NODE_ENV=production`、`APP_VERSION=<sha>`、`PORT=8080`、`NEXT_PUBLIC_APP_URL`、`ADMIN_HOSTS`、`STORAGE_BACKEND=postgresql`、`DATA_S3_BUCKET`、`DATA_S3_PREFIX=learning-guide/sandbox`、`AWS_REGION=ap-southeast-1`、`EMAIL_VERIFICATION_REQUIRED=1`、`LOCAL_SOCIAL_LOGIN=0`、`PAYMENT_MODE=stripe`、`STRIPE_SANDBOX=1`、`STRIPE_PRICE_*`（8 项）、`GOOGLE_CLIENT_ID`、`WECHAT_APP_ID`、`SMTP_HOST/PORT/SECURE/USER/FROM`、`SES_FROM_EMAIL`、`ADMIN_PORTAL_BASE_URL`。
- Secrets：`DATABASE_URL`、`SESSION_SECRET`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`GOOGLE_CLIENT_SECRET`、`WECHAT_APP_SECRET`、`SMTP_PASS`、`ADMIN_PORTAL_API_TOKEN`。
- **需运维配置密钥（已启用，未配置时降级）**：`OPENROUTER_API_KEY`（未配置 → 学员 AI 不可用）、`KS_TUTOR_API_KEY`（← `admin_api_key`）、`PORTAL_HELPDESK_TOKEN`、`ADMIN_HELPDESK_TOKEN`、`LIVEKIT_PROJECTS_SECRET_ID`/`LIVEKIT_PROJECTS_JSON`/`LIVEKIT_LOCAL_CREDENTIALS_JSON`、`STUDY_GROUP_TOKEN_LOG_KEY`、`PORTAL_INTEGRATION_TOKEN`。地址类变量已指向 Sandbox 自身：`KS_TUTOR_BASE_URL=https://admin.sandbox.ilovelearningguide.com`、`OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`、`ADMIN_HELPDESK_BASE_URL=https://admin.sandbox.ilovelearningguide.com`。

### 3.2 Admin Sandbox（App Runner 变量 / Secrets）

- 普通变量：`APP_ENV=SANDBOX`、`NODE_ENV=production`、`PORT=3000`、`AWS_REGION=ap-southeast-1`、`AUTH_ENABLED=true`、`BACKOFFICE_APP_URL=https://admin.sandbox.ilovelearningguide.com`、`ENVIRONMENT_LABEL=Sandbox`、`VERSION_NUMBERING_MODE=sandbox`、`PUBLIC_SITE_URL=https://sandbox.ilovelearningguide.com`、`COURSE_MEDIA_BUCKET`、`COURSE_MEDIA_PREFIX`、`COURSE_PACKAGE_BUCKET`、`COURSE_PACKAGE_PREFIX=staging/`、`PACKAGE_SOURCE_ENFORCEMENT=off`、`OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`、`PORTAL_HELPDESK_BASE_URL=https://sandbox.ilovelearningguide.com`、`PORTAL_NOTIFICATIONS_BASE_URL=https://sandbox.ilovelearningguide.com`、`PORTAL_STUDENTS_BASE_URL=https://sandbox.ilovelearningguide.com`、`SMTP_HOST/PORT/SECURE/USER/FROM`、`SES_FROM_EMAIL`；`APP_ROLES` 与 `ADMIN_CAPABILITIES` **不设置**（全角色、全模块）。
- 其中 `ENVIRONMENT_LABEL`、`VERSION_NUMBERING_MODE` 由 `scripts/provision-admin-dev.mjs` 在 `ADMIN_ENV=sandbox` 时自动写入；`APP_ROLES`/`ADMIN_CAPABILITIES` 脚本不再写入（未设置即全开）。仅手工部署路径需要人工注入普通变量。
- Secrets：`DATABASE_URL`、`AUTH_TOKEN`（← `admin_api_key`）、`SESSION_SECRET`、`BOOTSTRAP_ADMIN_PASSWORD`、`PORTAL_PREVIEW_SECRET`、`STRIPE_SECRET_KEY`、`OPENROUTER_API_KEY`、`AI_CONFIG_ENCRYPTION_KEY`、`KS_SERVICE_TOKEN`、`PORTAL_HELPDESK_TOKEN`、`ADMIN_HELPDESK_TOKEN`、`PORTAL_NOTIFICATIONS_TOKEN`、`PORTAL_STUDENTS_TOKEN`、`SMTP_PASS`；（可选）`STRIPE_WEBHOOK_SECRET`。
- **需运维配置（已启用，未配置时降级）**：`AI_AVAILABLE_MODELS`（非密钥，模型清单）、`AI_RATE_LIMIT_*`（非密钥，沿用代码缺省）、`KS_BASE_URL` 留空（本服务同时起 ks 角色，直接读库）、`HELPDESK_*` 模型参数（非密钥，沿用缺省）；`ENV_CAPABILITY_ENFORCEMENT` 保持不设置（Part C 未接线，默认 off）。

### 3.3 跨服务配对（必须一致）

| 配对 | Admin Sandbox | Portal Sandbox | 说明 |
|---|---|---|---|
| 学员端/目录 API Key | `AUTH_TOKEN` | `ADMIN_PORTAL_API_TOKEN` / `KS_TUTOR_API_KEY` | 都指向 `learning-guide/admin/sandbox/admin_api_key`；Portal 调 Admin `/api/portal/v1/**`、`/api/user/**`、`/api/ks/**`，Admin 端按 `X-API-Key`/Bearer == `AUTH_TOKEN` 校验 |
| 站点地址 | `PUBLIC_SITE_URL` | `NEXT_PUBLIC_APP_URL` | 同一个 sandbox 域名 |
| 方向 | `PORTAL_HELPDESK_BASE_URL` / `PORTAL_NOTIFICATIONS_BASE_URL` / `PORTAL_STUDENTS_BASE_URL` → Portal | `ADMIN_PORTAL_BASE_URL` / `ADMIN_HELPDESK_BASE_URL` / `KS_TUTOR_BASE_URL` → Admin | 双向；地址已指向 Sandbox 自身 |
| Helpdesk | `PORTAL_HELPDESK_TOKEN`、`ADMIN_HELPDESK_TOKEN` | `ADMIN_HELPDESK_TOKEN`、`PORTAL_HELPDESK_TOKEN` | 成对一致；未配置时按设计 503 `HELPDESK_NOT_CONNECTED` / `integration_disabled` |
| AI Tutor | `OPENROUTER_API_KEY`、`AI_CONFIG_ENCRYPTION_KEY` | `OPENROUTER_API_KEY`、`KS_TUTOR_API_KEY` | `agent`/`ks` 角色全起；缺 key 时 AI 端点返回未配置错误，不伪造可用 |

### 3.4 Secrets Manager 命名建议

- Portal：`learning-guide/sandbox/{database_url, session_secret, stripe_secret_key, stripe_webhook_secret, google_client_secret, wechat_app_secret, smtp_pass, openrouter_api_key, admin_helpdesk_token, portal_helpdesk_token, portal_integration_token, portal_notifications_token, portal_students_token, livekit_projects_json, livekit_local_credentials_json, study_group_token_log_key}`
- Admin：`learning-guide/admin/sandbox/{database_url, admin_api_key, session_secret, bootstrap_admin_password, portal_preview_secret, stripe_secret_key, smtp_pass, openrouter_api_key, ai_config_encryption_key, ks_service_token}`

> `admin_api_key` 由 provision 脚本创建；服务端读取的变量名是 `AUTH_TOKEN`，脚本已把 `RuntimeEnvironmentSecrets.AUTH_TOKEN` 指向该 secret ARN（G11 已在本分支修复），不要新增明文变量。

---

## 4. 仓库侧配置清单

### 4.1 Admin（`First-Light-TechHK/LearningGuideAdmin`）

| 类型 | 名称 | 用途 |
|---|---|---|
| Repo variable | `ADMIN_SANDBOX_APP_RUNNER_SERVICE_ARN` | sandbox 部署工作流目标（S4） |
| Repo secret | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 专用 IAM 用户（策略模板 `deploy/ci-iam-policy.json.template`） |
| Workflow | `.github/workflows/sandbox-deploy.yml`（待安装） | 从 `deploy/admin-sandbox-deploy.yml.template` 复制；手动/推送触发；等待 CI；轮询 Operation 到 `SUCCEEDED` |
| 可选变量 | `SANDBOX_OPENROUTER_API_KEY_SECRET_ARN` 等 | AI Tutor 已启用；运维配置 ARN 后自动注入，未配置时步骤跳过、AI 端点按设计不可用 |

### 4.2 Portal（`First-Light-TechHK/LearningGuidePortal`）

| 类型 | 名称 | 用途 |
|---|---|---|
| Repo variable | `SANDBOX_APP_RUNNER_SERVICE_ARN` | sandbox 部署工作流目标（S5，Portal 仓库任务） |
| Repo variable | `SANDBOX_ORIGIN` / `SANDBOX_ADMIN_ORIGIN` | `https://sandbox.ilovelearningguide.com` / `https://admin.sandbox.ilovelearningguide.com` |
| Repo secret | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 建议专用 IAM 用户 |
| Workflow | `.github/workflows/sandbox-deploy.yml`（模板本仓库 `deploy/portal-sandbox-deploy.yml.template`，待安装到 Portal 仓库） | 推送 `sandbox` 分支/手动触发 + 发布后 live e2e；`release/environments.mjs` 的 SANDBOX 条目（D10）已在 Portal 工作区实现（待提交/部署验证） |

### 4.3 本仓库（Admin）已落地的 Sandbox 内容

- `deploy/sandbox.example.env` — 两服务变量模板（占位符 + 全模块/全角色与密钥降级说明）。
- `deploy/sandbox-infrastructure.yml` — Portal 侧网络/DB/桶/角色 CloudFormation 模板。
- `deploy/admin-sandbox-deploy.yml.template` — Admin sandbox 部署工作流模板。
- `deploy/portal-sandbox-deploy.yml.template` — Portal sandbox 部署工作流模板（F4 合并；安装属 Portal 仓库任务）。
- `deploy/ci-iam-policy.json.template` — CI 用户 IAM 策略模板。
- `scripts/sandbox-smoke.mjs` — 验收 smoke（`--self-test` 本地自测 + live HTTP 断言）。
- `docs/sandbox/{partitioning,environments,provisioning-request,acceptance-checklist}.md` — 本套文档。
- `docs/sandbox/aws-readiness.md` — Day-0 AWS 执行手册（F4 合并）。
- `docs/sandbox/ops-request-draft.md` — ops 申请邮件/工单草稿（F4 合并）。
- `docs/sandbox/review-findings.md` — R1–R21 历史审查追溯（F4 合并）。

---

## 5. 分步搭建与验收清单

> 每步给出验收标准；未通过不得进入下一步。命令中的账号/ARN 以 ops 实际分配为准。

### Phase 0 决策与前置

| 步骤 | 执行 | 验收标准 |
|---|---|---|
| 0.1 | 拍板 §7 Q1–Q10 | 书面结论记录在本文件或工单 |
| 0.2 | 确认 AWS 账号、region（`ap-southeast-1`）、月度预算 | 预算审批记录；Cost Explorer 可查 |
| 0.3 | 确认域名与 DNS owner | 两个子域书面确认 |
| 0.4 | 确认 Stripe 测试账号与 8 个 Lookup Key | Dashboard 可见 8 个 active test price |
| 0.5 | 确认分支策略：`sandbox` 分支存在且 = 上游最近一次生产发布（UAT）SHA 快进 | `git rev-parse sandbox` 可追溯 |

### Phase 1 AWS 基础设施

| 步骤 | 执行 | 验收标准 |
|---|---|---|
| 1.1 | ops 执行 `deploy/sandbox-infrastructure.yml`：`aws cloudformation deploy --stack-name learning-guide-sandbox --capabilities CAPABILITY_NAMED_IAM` | 栈 `CREATE_COMPLETE`；Outputs 齐全（DatabaseHost/MasterSecret/ConnectorArn/AppRoleArn/ScalingArn/BucketName/AppSecurityGroup/PrivateSubnet） |
| 1.2 | 核对 RDS | available；`PubliclyAccessible=false`；`StorageEncrypted=true`；备份 7 天 |
| 1.3 | 核对 S3 | 公共访问块 4 项全 true；版本化 Enabled；拒绝非 TLS |
| 1.4 | 核对网络 | 私有子网无公网 IP；NAT/EIP/S3 Endpoint available；DB SG 只接受 App SG |
| 1.5 | 核对 IAM | 运行时角色只读 `learning-guide/sandbox/*`、只写 sandbox 桶/前缀；IAM Policy Simulator 验证跨环境 denied |
| 1.6 | Admin RDS + 密钥 + 课程桶（ops 先建运行时角色与桶，再跑）：<br>`ADMIN_ENV=sandbox ADMIN_BRANCH=sandbox AUTH_ENABLED=true VPC_ID=… SUBNET_IDS=… SECURITY_GROUP_ID=… GITHUB_CONNECTION_ARN=… INSTANCE_ROLE_ARN=… VPC_CONNECTOR_ARN=… COURSE_MEDIA_BUCKET=learning-guide-admin-sandbox-course-<acct> node scripts/provision-admin-dev.mjs --apply` | `learning-guide-admin-sandbox` available、私有、加密、备份 7 天；secrets ARN 存在；`AUTH_TOKEN` 映射正确；App Runner `AutoDeploymentsEnabled=false`；运行时变量含 `ENVIRONMENT_LABEL=Sandbox`、`VERSION_NUMBERING_MODE=sandbox`，**不含** `APP_ROLES`/`ADMIN_CAPABILITIES`（未设置 = 全角色、全模块） |

### Phase 2 Admin Sandbox

| 步骤 | 执行 | 验收标准 |
|---|---|---|
| 2.1 | 部署 App Runner（S4 / 手工），注入 §3.2 配置；`AUTH_ENABLED=true`、`AUTH_TOKEN` 指向 `admin_api_key` secret（`ENVIRONMENT_LABEL`/`VERSION_NUMBERING_MODE` 已由 Phase 1.6 脚本写入；`APP_ROLES`/`ADMIN_CAPABILITIES` 保持不设置；手工路径需核对） | RUNNING；`GET /api/health` 200 且 `environment=SANDBOX` |
| 2.2 | 启动时 `npx prisma migrate deploy` | `_prisma_migrations` 无失败；`pg_extension` 中 `vector` 存在 |
| 2.3 | 分类预置核对 | `SELECT name FROM "CourseCatalogueEntry" WHERE "parentId" IS NULL ORDER BY "sortOrder"` 返回 `Science`、`Chinese Humanities`、`European Humanities`、`Society` |
| 2.4 | 初始化 Operator 账号并登录 | 登录成功；`GET /api/backoffice/environment` 返回 `label="Sandbox"`、`versionNumberingMode="sandbox"`、`stripeConfigured=true` |
| 2.5 | 环境徽标 | 后台页头紫色 `Sandbox` 徽标（`client/src/backoffice/components/AppShell.tsx`） |
| 2.6 | Stripe 价格同步 | 课程价格页保存并同步 8 个价格；Dashboard（test mode）出现对应 Product/Price；无 `syncError` |
| 2.7 | 课程闭环（核心） | 新建课程 → 上传媒体（S3）→ 保存草稿 → Publish；版本号 `1.1`；改动后再次 Publish `1.2` |
| 2.8 | 导出与版本序列 | 导出课程包；`CourseVersion.exportedAt` 已写入；再次发布得到 `2.1` |
| 2.9 | 能力/角色核对 | 全角色已起：`/api/user/**`、`/api/ks/**` 已挂载且要求服务密钥（假 key → 401）；Helpdesk 未配置令牌返回 503（不是 404）；AI 未配置 key 时明确提示未配置，不崩溃。显式设 `APP_ROLES`/`ADMIN_CAPABILITIES` 才出现裁剪（404 `MODULE_NOT_ENABLED`） |

### Phase 3 Portal Sandbox

| 步骤 | 执行 | 验收标准 |
|---|---|---|
| 3.1 | 部署 Portal App Runner（S5），注入 §3.1 配置 | RUNNING；`GET /api/health` 200，`environment=SANDBOX`、`version=<sha>` |
| 3.2 | 数据库与对象存储自检 | `/api/health` 的 `checks.database=true`、`checks.paymentMigration=true`、`checks.storage=true`；S3 `.deployment-ready` 存在（若部署的 Portal 未含 Portal 工作区 D3 修复，`checks=null`，按验收清单逐项人工核对） |
| 3.3 | 配置完整性自检 | `/api/health/config`：`storage=postgresql+s3`；google/wechat/email `configured`；`payment.lookupKeys` 8 项 `configured`；`missing=[]` |
| 3.4 | 登录 | Google / WeChat / 邮箱密码至少各完成一次真实登录；`LOCAL_SOCIAL_LOGIN=0` 下无本地账号入口 |
| 3.5 | 测试账号 | 每个客户角色至少 1 个测试账号可登录、可订阅、可学习 |
| 3.6 | Stripe 支付 | 测试卡完成订阅 → 订单 paid、entitlement 生效；`livemode=false`；webhook 验签 200；过期/取消会话不授权 |
| 3.7 | 课程展示 | 测试账号能看到并播放课程（Portal 尚未消费 Admin 课程投影，D6；首期用 Portal 数据迁移导入同课程过渡验收） |
| 3.8 | AI Tutor | 全启用：配置 `OPENROUTER_API_KEY` 后验收学员对话与后台测试对话；未配置时确认明确提示未配置（不崩溃、不伪造成功） |
| 3.9 | 邮件 | 注册验证、密码重置真实收件；链接域名为 sandbox 域名 |
| 3.10 | 后台配对 | Portal 分类筛选读取 Admin Sandbox 分类（`/api/portal/v1/categories`，4 个顶级分类）；Helpdesk 令牌配置后验收一对工单/FAQ，未配置时确认 503 |

### Phase 4 隔离与安全验收

| 步骤 | 执行 | 验收标准 |
|---|---|---|
| 4.1 | 数据库隔离 | Sandbox `DATABASE_URL` 与其它环境不同；用 UAT 凭据连 Sandbox DB 失败；库中无真实学员数据 |
| 4.2 | 对象存储隔离 | Sandbox 角色读其它环境前缀 → AccessDenied；反向亦然 |
| 4.3 | 服务鉴权隔离 | 用其它环境 token 调 Sandbox Admin `/api/portal/v1/courses` → 401；反之亦然 |
| 4.4 | Stripe 隔离 | 所有 Checkout `livemode=false`；Sandbox 配置中无 `sk_live_`；webhook 只指向 sandbox 域名 |
| 4.5 | 域名与 Cookie | sandbox 域名会话 Cookie 不在别的域生效；跨域跳转不携带凭据 |
| 4.6 | 密钥卫生 | 仓库、GitHub variables、CloudWatch 日志均无真实密钥；值只在 Secrets Manager |
| 4.7 | 出站最小化 | App Runner 仅经 NAT 出站 443/465；无入站 DB 端口 |

### Phase 5 课程包 Sandbox → Production 端到端

| 步骤 | 执行 | 验收标准 |
|---|---|---|
| 5.1 | Sandbox 发布并导出课程包 | 包内含 manifest、模板、媒体；版本标签 `X.Y`；History 记录 `EXPORT_PACKAGE` |
| 5.2 | 生产 Admin（当前 UAT）导入 | 导入成功并生成草稿；来源显示 `Sandbox X.Y`；媒体落到生产 Admin 桶 |
| 5.3 | 生产发布 | Publish 生成整数 `Version N`；状态可 Online/Hidden/Offline；学员端可见 |
| 5.4 | 来源强制（契约已定，开关默认 off） | Part C 接线后：生产 `PACKAGE_SOURCE_ENFORCEMENT=on` 时 Sandbox 包导入成功；伪造 `provenance.sourceEnv="production"` 的包被拒 `PACKAGE_SOURCE_NOT_ALLOWED`；当前基线（87e0be2）未接线，只能靠操作规程 |
| 5.5 | 能力矩阵（契约已定，开关默认 off） | Part C 接线后：生产 authoring/新建/结构变更 → 403 `CAPABILITY_DISABLED`；import/publish/restore/status 可用。Sandbox 全部可用（保持 off） |

### Phase 6 运营就绪

| 步骤 | 执行 | 验收标准 |
|---|---|---|
| 6.1 | 数据重置策略落地（§7 Q5） | 演练一次：重置后测试账号可重新购买/学习；课程内容不受影响 |
| 6.2 | 备份与恢复演练 | Admin RDS 快照恢复演练；课程包导出作为第二重保障 |
| 6.3 | 监控告警 | 5xx/延迟/DB CPU/存储/webhook 失败告警可触发；接收人确认 |
| 6.4 | 成本核查 | 上线 24 小时后 Cost Explorer 核对（参考：SIT 约 USD 80–100/月含 NAT；Sandbox 预计 USD 110–170/月，媒体存储另计） |
| 6.5 | 代码同步机制 | 每次生产发布后 `sandbox` 分支快进到该生产发布 SHA（UAT=当前生产，同码）；修复合入上游 dev 后随下一次生产发布进入；记录在发布 checklist |

---

## 6. 代码侧就绪度与缺口

> 基线：Admin `feat/sandbox-provisioning`（= `origin/dev` 87e0be2）；Portal `feat/sandbox-provisioning`（= `upstream/dev` a632480f）。本分支只改 Admin 部署脚本/文档/测试，不改课程业务语义（仅环境标识与托管就绪语义）。

### 6.1 已就绪

| # | 能力 | 证据 |
|---|---|---|
| R1 | 版本编号可配置 | `server/src/commerce-courses/commerce.config.ts:6,46-56`：`VERSION_NUMBERING_MODE` 缺省 `sandbox`；`publishing.service.ts` 实现 `X.Y` 与导出后系列 +1；生产 `Version N` |
| R2 | 环境标识与徽标 | `ENVIRONMENT_LABEL`（`commerce.config.ts:49-53`）；`GET /api/backoffice/environment` 返回 label/versionNumberingMode/stripeConfigured（`environment.controller.ts`）；页头紫色 Sandbox / 红色 Production（`client/src/backoffice/components/AppShell.tsx`） |
| R3 | 分类 seed | Prisma 迁移幂等插入顶级分类；`start-admin.sh` 启动执行 `prisma migrate deploy` |
| R4 | pgvector | 迁移 `20261026000000_add_knowledge_chunk` 执行 `CREATE EXTENSION IF NOT EXISTS vector` |
| R5 | Admin 健康检查 | `GET /api/health` 返回 service/environment（`server/src/health/health.controller.ts`） |
| R6 | Portal 健康与配置自检 | `/api/health` 返回 environment/version/ready/checks；`/api/health/config` 只报状态不泄露密钥 |
| R7 | Portal 读 Admin 分类 | `services/adminCatalogue.ts`：`ADMIN_PORTAL_BASE_URL/ADMIN_PORTAL_API_TOKEN`，`X-API-Key` 对应 Admin `AUTH_TOKEN` |
| R8 | Admin `APP_ENV=SANDBOX` 独立标识 | `server/src/backoffice/lib/env.ts`（本分支）+ `env.spec.ts`（13 个用例） |
| R9 | Admin provision/sandbox 部署模板 | `scripts/provision-admin-dev.mjs`（本分支）、`deploy/admin-sandbox-deploy.yml.template`、`deploy/sandbox.example.env`、`deploy/sandbox-infrastructure.yml` |

### 6.2 缺口

| # | 缺口 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| G1 | `ENV_CAPABILITY_ENFORCEMENT` 未在本基线 | 上游 dev 87e0be2 无 `server/src/partc/**`；变量无人读取（Part C 半成品在 `fix/course-category-single-source`，已 stash） | 生产/UAT 仍可 authoring；"生产只导入"只能靠操作规程 | Part C 集成时接线，开关默认 off；UI/生产演练后再开 |
| G2 | `PACKAGE_SOURCE_ENFORCEMENT` 未在本基线 | 同上（`src/partc/compiler/parse.ts` 不在基线） | 导入不校验 provenance | 同 G1；Sandbox 保持 off |
| G3 | ~~Admin 环境枚举不含 SANDBOX~~ | **本分支已修复**：`env.ts` + `env.spec.ts` | — | — |
| G4 | ~~Admin provision 不支持 sandbox~~ | **本分支已修复**：`ADMIN_ENV=sandbox` 全套约束（分支必传/AUTH 强制/AUTH_TOKEN 映射/桶名/备份 7 天/关闭自动部署；**不写 `APP_ROLES`/`ADMIN_CAPABILITIES` = 全角色、全模块**，只显式写入环境标识与编号，F3b） | — | — |
| G5 | Admin 部署工作流未安装 | 仓库 `.github/workflows/` 只有 dev-deploy/ci；模板在 `deploy/` | 需复制模板到 `.github/workflows/sandbox-deploy.yml` 并配置仓库变量 | 部署前由 eng 安装 |
| G6 | ~~Portal `isManagedEnvironment()` 不含 SANDBOX~~ | **Portal 工作区已实现**（待提交/部署验证）：`isManagedEnvironment()` 含 SANDBOX、Stripe 沙盒强校验覆盖 SANDBOX（Portal 工作区 `services/runtimeConfig.ts:12-16,95`） | — | — |
| G7 | ~~Portal provision 只支持 SIT/UAT~~ | **Portal 工作区已实现**（待提交/部署验证）：`scripts/provision-uat.mjs` 参数化 sandbox tier（`PORTAL_ENV=sandbox`，Portal 工作区 `scripts/provision-uat.mjs:66-111`） | — | — |
| G8 | Portal 未消费 Admin 课程投影 | Portal 仅拉 `/api/portal/v1/categories`；课程卡片/详情仍来自 Portal 自有数据 | Sandbox 端到端"内容上架即可学"缺一段 | 另立 Portal 集成任务；首期用数据迁移过渡 |
| G9 | 测试账号/重置脚本缺失 | Portal 无 sandbox 测试账号 seed/reset | PRD §3.2 无法例行执行 | Portal 仓库新增脚本 |
| G10 | ~~Admin `.env.example` 未列部署变量~~ | **本分支已补**：`VERSION_NUMBERING_MODE`/`ENVIRONMENT_LABEL`/能力开关说明 | — | — |
| G11 | ~~secret 名与变量名不一致~~ | **本分支已修复**：脚本映射 `AUTH_TOKEN ← admin_api_key` ARN | — | — |
| G12 | ~~Admin RDS 备份默认 1 天~~ | **本分支已修复**：Sandbox 7 天 | — | — |
| G13 | Admin 无 live Stripe key 运行时防护 | Admin 只看 `STRIPE_SECRET_KEY` 值 | 填错 key 会把 Sandbox 指向正式账号 | 部署检查项（`sk_test_` 前缀）+ 后续启动校验 |
| G14 | Study Group（LiveKit）取舍 | — | 已启用；LiveKit 密钥由运维配置，未配置时直播间不可用（接受 `configured:false`） | 运维配置 `LIVEKIT_*` / `STUDY_GROUP_TOKEN_LOG_KEY` |

### 6.3 结论

- **可以开始 ops 资源创建**：Admin 侧 provision/部署模板与验收材料已在本分支齐备；Portal 侧 G6/G7/D10 已在 Portal 工作区实现（待提交/部署验证；不阻塞 Admin 拉起，但 Portal 验收的"真绿"需先提交并部署该修复）。
- **暂不能宣称"生产只导入"**：G1/G2 在本基线未接线；先按操作规程执行，Part C 接线并在 UAT 演练后再开 `on`。
- **最大业务缺口是 G8**（Admin→Portal 课程投影未接）。

---

## 7. 待 ops / 产品拍板的开放问题

| # | 问题 | 建议 | 决策人 |
|---|---|---|---|
| Q1 | AWS 账号：现有账号内独立栈，还是新账号？ | 现有账号内独立 CloudFormation 栈（隔离靠命名空间与 IAM）；安全硬隔离要求出现时再开新账号 | LEO / ops |
| Q2 | 域名与 DNS：两个子域是否批准？记录由谁加？ | 采用两个子域；DNSPod 由客户 DNS owner 添加，ops 提供 App Runner 输出值 | 产品 / DNS owner |
| Q3 | Stripe 测试账号：共用还是独立？ | 建议独立测试账号（避免 webhook 跨环境投递、便于对账与限额）；共用时至少独立 endpoint 与 Lookup Key 前缀 | 产品 / finance |
| Q4 | 邮件通道：共用 163 SMTP 还是新邮箱？ | 首期共用 163 SMTP，主题加 `[Sandbox]`；SES 仍在 sandbox 模式 | ops / 产品 |
| Q5 | 数据重置策略：频率、范围、执行人、是否保留课程内容？ | 例行只重置测试学员数据（订单/订阅/权益/学习记录），课程保留；季度可整栈重建（先导出课程包） | 产品 / ops |
| Q6 | WeChat 网站应用：新建还是在现有应用加授权域？ | 按"一环境一应用"惯例新建 | 产品 |
| Q7 | 代码同步：谁在何时把 `sandbox` 分支快进到最近一次生产发布 SHA？ | 每次生产发布后由发布负责人把 `sandbox` 分支快进到该发布 SHA 并登记；修复合入上游 dev 后随下一次生产发布进入 | eng / 发布负责人 |
| Q8 | Study Group（LiveKit）是否纳入？ | 已随“全模块”纳入；密钥由运维配置，未配置时不可用 | 产品 |
| Q9 | OpenRouter key 与预算？ | AI Tutor 已启用，需要产品/运维提供 key 与预算上限；未配置时 AI 端点按设计不可用 | 产品 / eng |
| Q10 | 测试账号身份来源：邮箱/微信账号由谁提供？ | 产品提供每个客户角色至少 1 个可收件邮箱与 1 个可扫码微信账号；清单只存密码管理器 | 产品 |

---

## 8. 完成定义

1. §2 资源全部创建并通过验收；§5 Phase 0–4 全部通过。
2. Admin Sandbox：`/api/health` 200 且 `environment=SANDBOX`；紫色 `Sandbox` 徽标；`versionNumberingMode=sandbox`；4 个预置分类存在；Stripe 测试价格同步成功；全模块、全角色启用（未配置密钥的功能按设计降级）。
3. Portal Sandbox：`/api/health` 200 且 `environment=SANDBOX`；`/api/health/config` 逐项 `configured`；测试账号可登录、订阅（测试卡）、学习。
4. 隔离验收（Phase 4）全部通过：数据库、S3、密钥、token、域名、Stripe 六项互不可达/不可混用。
5. 课程包 Sandbox → 当前生产（UAT）导入、发布成功；来源字段正确。
6. 数据重置与备份恢复演练通过；监控告警可触发；成本在预算内。
7. 文档与配置（本文件、`deploy/sandbox.example.env`、`docs/sandbox/{partitioning,environments,acceptance-checklist,aws-readiness,ops-request-draft,review-findings}.md`、Admin sandbox 工作流）评审并合入。

---

## 9. 回滚与下线

- **代码回滚**：按 App Runner 上一个成功 Operation 回滚；禁止改生产服务来"修" Sandbox。
- **数据回滚**：Admin RDS 快照/PITR（7 天）；Portal 数据可重建；课程内容以最近导出包为准（导出是强制备份手段）。
- **下线**：先导出全部课程包并归档 S3，再删 App Runner；RDS `DeletionPolicy=Snapshot`、S3 `Retain`。不涉及 Production 资源。

---

## 附录：参考文件

| 主题 | 位置 |
|---|---|
| PRD（Sandbox/Production 规则） | `docs/prd.md` §3.1、第 15 章 |
| 逻辑分区与命名规则 | `docs/sandbox/partitioning.md` |
| 环境矩阵与风险项 | `docs/sandbox/environments.md` |
| 验收清单 | `docs/sandbox/acceptance-checklist.md` |
| Admin 部署现状 | `docs/admin-dev-stack.md`、`scripts/provision-admin-dev.mjs`、`.github/workflows/dev-deploy.yml` |
| Admin→Portal 投影 API | `docs/Portal_Projection_API.md` |
| 课程导入导出设计 | `docs/Course_Module_Import_Export_Design.md` |

> 再次声明：本文件编制过程中未创建任何 AWS 资源、未调用 AWS API、未使用 First-Light-TechHK 账号、未提交任何真实密钥。资源创建由 ops 按 §2 清单执行。
