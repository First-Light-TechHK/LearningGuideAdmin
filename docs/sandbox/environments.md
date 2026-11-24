# Sandbox 环境矩阵与配置契约

> 原则：同一套代码、不同配置。Sandbox 是**独立部署**（owner 2026-11-16 拍板）：独立库/桶/密钥命名空间，环境差异只由配置表达，**禁止环境专属代码分支**。
> 本文件 2026-11-19 按 Admin 分支 `feat/sandbox-provisioning`（基线 `origin/dev` 87e0be2）与 Portal 分支 `feat/sandbox-provisioning`（基线 `upstream/dev` a632480f，含 Portal 工作区未提交改动）核对；同日按最终复验 F3b/F5/F9 修订。逻辑分区与命名规则见 `docs/sandbox/partitioning.md`。
> 文中"Portal 工作区"= `/Users/nihao/AI infra/LearningGuidePortal`（改动尚未提交；"待提交/部署验证"指提交并部署后才作为验收依据）。

## 1. 环境总表

| 环境 | 角色 | Admin 版本编号（`VERSION_NUMBERING_MODE`） | Stripe | 内容写权限（目标态） | 当前状态 |
|---|---|---|---|---|---|
| DEV | 开发 | `sandbox`（代码缺省）→ `X.Y` | 测试 | 全开 | 存在 |
| SIT | 集成测试 | `sandbox`（代码缺省）→ `X.Y` | 测试 | 全开 | 存在 |
| **UAT（= 当前生产）** | 学员正式使用 | 需显式 `production` → `Version N`（D1） | 测试（`STRIPE_SANDBOX=1`）；正式收款需产品确认 | **import-only（目标态，经 provenance 门）** | 存在，目前直接维护内容 |
| PPE | 预生产 | `production` → `Version N` | 正式（仅批准后） | import-only（目标态） | 存在 |
| **Sandbox（新建）** | 内容验证：Operator 在 Admin 创作/导出，客户在 Course Sandbox 前台测试 | `sandbox` → `X.Y` | 测试（`sk_test_…`） | **authoring 全开**（能力分区：只开课程管理与导入导出） | 未建；本分支已提供 Admin 侧 provision/部署模板与申请/验收文档；Portal 侧代码前置（D3/D10/G6/G7）已在 Portal 工作区实现，待提交/部署验证 |

> 编号说明：`VERSION_NUMBERING_MODE` 是 Admin 独有配置（`server/src/commerce-courses/commerce.config.ts`），缺省即 `sandbox`。本分支起，`scripts/provision-admin-dev.mjs` 在 `ADMIN_ENV=sandbox` 时**显式写入** `VERSION_NUMBERING_MODE=sandbox`、`ENVIRONMENT_LABEL=Sandbox`、`APP_ROLES=admin`、`ADMIN_CAPABILITIES=course,accounts`（dev/sit/uat 保持历史行为，不写这些变量）。因此 **UAT Admin 若未显式设 `VERSION_NUMBERING_MODE=production`，页头徽标与版本号会显示 Sandbox 语义**（D1）；`server/.env.example` 已补该变量说明（本分支）。

## 2. 逻辑分区（六维）与命名命名空间

| 维度 | Sandbox | 其它环境 |
|---|---|---|
| 数据库 | RDS `learning-guide-admin-sandbox`（库 `learning_guide_admin_sandbox`、账号 `lg_admin_sandbox`）；Portal 侧 `learning-guide-sandbox`（库 `learning_guide_sandbox`） | 各自独立实例，不共库 |
| 对象存储 | Admin 桶 `learning-guide-admin-sandbox-course-<账号>`；Portal 桶 `learning-guide-sandbox-<账号>` + 前缀 `learning-guide/sandbox/` | 各自独立桶/前缀，不做跨环境桶授权 |
| Secrets | `learning-guide/admin/sandbox/*`、`learning-guide/sandbox/*` | 一环境一命名空间 |
| 域名 | `sandbox.ilovelearningguide.com`、`admin.sandbox.ilovelearningguide.com`；会话 Cookie host-only | 独立主机名 |
| Stripe | 测试账号/测试模式（`sk_test_…`、`livemode=false`、独立 webhook） | 生产正式；UAT 按现配置 |
| 版本编号模式 | `VERSION_NUMBERING_MODE=sandbox`、`ENVIRONMENT_LABEL=Sandbox` | 生产/PPE 为 `production` |

命名规则、授权边界与完整清单见 `docs/sandbox/partitioning.md` §2–§3。

## 3. 分支契约（`sandbox` 分支 = 上游最近一次生产发布 SHA 快进）

**硬规则**（owner 2026-11-16 定调、2026-11-19 复验 F9 统一表述；PRD 第 3.1 节“Production 每次发版，Sandbox 同步升级到同一代码版本”的工程落地；**UAT = 当前生产**）：

1. **只快进**：`sandbox` 分支只允许把**上游最近一次生产发布（当前生产 = UAT）的发布 SHA** 直接快进过来（fast-forward），**禁止任何 sandbox 专属提交、禁止把 dev/feature 分支直接指给 Sandbox 部署**。修复合入上游 `dev` 后**不会立即进入 Sandbox——随下一次生产发布进入**：每次生产发布完成后，把 `sandbox` 分支快进到该发布 SHA。
2. **同码**：Sandbox 两服务与生产（UAT）运行同一套代码、同一套功能；生产发布的代码即 `sandbox` 分支快进目标，因此“发版后同码”等价于“`sandbox` 分支快进到该生产发布 SHA”。功能差异只能来自配置（环境标识、域名、Stripe key、数据库/桶/密钥命名空间、能力开关）。
3. **部署门禁**：Admin sandbox 部署工作流（`deploy/admin-sandbox-deploy.yml.template`）只从 `sandbox` 分支构建；provision 脚本对 sandbox **关闭 App Runner 分支自动部署**（`AutoDeploymentsEnabled=false`，本分支实现），工作流是唯一发布者，且先等 CI 通过再 `start-deployment`。
4. **验收**：Portal `GET /api/health` 的 `version` 必须等于本次部署的生产发布 SHA（`sandbox` 分支快进目标；smoke 的 `EXPECTED_VERSION` 断言）；Admin 不暴露 version 字段，用 App Runner 部署记录核对（`docs/sandbox/acceptance-checklist.md` B0）。
5. **例外**：新课程依赖尚未上线的新功能时，该课程的测试在开发 UAT 中随功能一起进行（PRD §3.1），不等 Sandbox 升级——这是流程例外，不是给 Sandbox 跑开发代码的理由。

## 4. 能力分区与两个强制开关

**能力分区**（owner 2026-11-16 拍板，详见 `docs/sandbox/partitioning.md` §5）：

- **Sandbox Admin 开放集 = `course.authoring` / `course.import` / `course.export`**（课程管理与导入导出）。只起 `admin` 角色（`APP_ROLES=admin`），BackOffice + 课程模块 + Portal 投影可用。
- **Helpdesk、学员端学生/AI Tutor（agent/ks 角色）、Study Group 首期不启用**：它们的变量不写入 sandbox 配置（`deploy/sandbox.example.env` 第三部分）。代码同源；未配置时按设计降级（Helpdesk 503、AI 端点不对外）。
- **生产目标态 = import-only**：内容只通过 Sandbox 导出的课程包进入生产，经 provenance 门（`provenance.sourceEnv=sandbox`）校验。

| 开关 | 默认 | 语义 | 生效条件 | 本分支状态 |
|---|---|---|---|---|
| `ENV_CAPABILITY_ENFORCEMENT` | `off` | on 时按环境矩阵强制 capability：production 禁 `course.authoring` → 403 `CAPABILITY_DISABLED`；环境由服务端 `VERSION_NUMBERING_MODE` 判定，不信任客户端 | 仅包含 Part C 接线的分支读取 | **未在本基线**：上游 dev 87e0be2 不含 `server/src/partc/**`，变量无人读取。Part C 半成品停在 `fix/course-category-single-source`（已 stash），与本分支无关。引入后默认仍为 `off`，Sandbox 永远 `off` |
| `PACKAGE_SOURCE_ENFORCEMENT` | `off` | production 且 on 时，确认导入前先按 v2 契约整包校验，再要求 `provenance.sourceEnv=sandbox`，否则 422 `PACKAGE_SOURCE_NOT_ALLOWED` | 同上（导入路径接线） | 同上：当前基线未接线；Sandbox 保持 `off`；生产/UAT 演练后再开 `on` |

> 约定：两个开关在任何分支上的默认值都是 `off`；Sandbox 自身永远保持 `off`（Sandbox 允许全部能力与任意来源导入）。强制只在 Production/UAT 打开，且必须先演练。

## 5. 各环境关键配置差异（已核对）

### 5.1 Admin

| 配置 | DEV / SIT / UAT（脚本现状） | Sandbox（本分支） | 证据 |
|---|---|---|---|
| `APP_ENV` | `DEV` / `SIT` / `UAT` | `SANDBOX`（`AppEnvName` 已含 SANDBOX，不再折叠为 DEV） | `server/src/backoffice/lib/env.ts:6,51-56`（本分支）；单测 `env.spec.ts` |
| `ENVIRONMENT_LABEL` | 脚本未设置 → 按编号模式推导（sandbox→"Sandbox"） | `Sandbox`（provision 脚本显式写入） | `commerce.config.ts:49-53`；`provision-admin-dev.mjs`（本分支 F3b） |
| `VERSION_NUMBERING_MODE` | 脚本未设置 → 默认 `sandbox`；UAT 需显式 `production` | `sandbox`（provision 脚本显式写入） | `commerce.config.ts:46-56`；`server/.env.example`（本分支补说明）；`provision-admin-dev.mjs`（本分支 F3b） |
| `AUTH_ENABLED` / `AUTH_TOKEN` | 脚本写入 `AUTH_ENABLED`（缺省 false）；`AUTH_TOKEN` ← `admin_api_key` secret ARN | 强制 `AUTH_ENABLED=true` + `AUTH_TOKEN` ← `admin_api_key` ARN | `scripts/provision-admin-dev.mjs`（本分支）；`server/src/common/guards/api-key.guard.ts` |
| `APP_ROLES` | 不设 = admin,agent,ks 全起 | `admin`（能力分区；provision 脚本显式写入） | `server/src/main.ts:65-66`、`app-roles.ts`；`provision-admin-dev.mjs`（本分支 F3b） |
| `ADMIN_CAPABILITIES` | 不设 = 全部能力（dev/sit/uat/prod 行为不变） | `course,accounts`（课程管理 + 员工账号管理；provision 脚本显式写入） | `server/src/common/capabilities.ts`；`provision-admin-dev.mjs`（本分支 F3b） |
| 数据库 | `learning-guide-admin-<env>`；PostgreSQL 16.13；pgvector | `learning-guide-admin-sandbox`；同版本 + pgvector；备份 7 天 | `provision-admin-dev.mjs`（sandbox 备份 7 天，本分支） |
| 课程存储 | DEV 桶 `learning-guide-admin-dev-course-851987565851` | `learning-guide-admin-sandbox-course-<账号>`（ops 预建） | `provision-admin-dev.mjs`（`-sandbox-` 命名空间，本分支） |
| App Runner 自动部署 | 分支自动部署（脚本 `AutoDeploymentsEnabled=true`） | **关闭**，由 sandbox 部署工作流发布 | `provision-admin-dev.mjs`（本分支） |
| Stripe | Admin 只用 `STRIPE_SECRET_KEY` 同步价格 | `sk_test_…` | `commerce.config.ts:57-59` |

### 5.2 Portal

| 配置 | DEV | SIT / UAT | Sandbox（新建） | 证据 |
|---|---|---|---|---|
| `APP_ENV` | `DEV` | `SIT` / `UAT` | `SANDBOX`（Portal 工作区已实现 `isManagedEnvironment()` 含 SANDBOX，待提交/部署验证；见 D3） | `services/runtimeConfig.ts:11-16`（Portal 工作区） |
| 存储 | `local` 或 PostgreSQL+S3 | `postgresql` + 独立桶/前缀 | `postgresql` + `learning-guide/sandbox` | `provision-{sit,uat}.mjs` |
| Stripe | DEV 可 demo 或本地沙盒 | `PAYMENT_MODE=stripe`、`STRIPE_SANDBOX=1`、`sk_test_…` | 同 SIT/UAT；`STRIPE_SANDBOX=1` 与 `sk_test_` 强校验已覆盖 SANDBOX（Portal 工作区，待提交/部署验证；`preflight:production` 限制 D4 仍在） | `runtimeConfig.ts:95`（Portal 工作区） |
| 登录 | 可 `LOCAL_SOCIAL_LOGIN=1` | `LOCAL_SOCIAL_LOGIN=0`，独立 Google/WeChat 应用 | 同 SIT/UAT | `provision-uat.mjs` |
| 邮件 | 可控制台/预览 | SMTP（163）优先，SES 回退 | 同 SIT/UAT | `runtimeConfig.ts:79`、`emailService.ts` |
| AI Tutor | 可本地 | `KS_TUTOR_BASE_URL` → 同环境 Admin | **首期不启用**（能力分区；不写 AI 变量） | `services/adminCatalogue.ts:37-41` |

## 6. 代码现状差异与风险项

| # | 差异 | 影响 | 处理 |
|---|---|---|---|
| D1 | UAT Admin 的 `VERSION_NUMBERING_MODE` 未由脚本写入，环境标识从编号模式静默推导、无启动校验 | UAT 若未显式配置 `production`，页头徽标与编号会按 Sandbox 显示（`1.1` 而不是 `Version 1`），导出包的 provenance 会写入 sandbox 语义 | 上线前核查 UAT App Runner 配置并显式设 `VERSION_NUMBERING_MODE=production` |
| D2 | ~~Admin `AppEnvName` 不含 `SANDBOX`，折叠为 DEV~~ | **本分支已修复**：`SANDBOX` 单独保留；helpdesk 启动 seed 只认显式 `APP_ENV=DEV`，Sandbox 不会被灌演示数据 | `server/src/backoffice/lib/env.ts` + `env.spec.ts` |
| D3 | ~~Portal `isManagedEnvironment()` 不含 `SANDBOX`~~ | **Portal 工作区已实现**（待提交/部署验证）：`isManagedEnvironment()` 含 SANDBOX、Stripe 沙盒强校验覆盖 SANDBOX；未包含该修复的部署仍会 `checks=null`，smoke 标 fail | Portal 工作区 `services/runtimeConfig.ts:12-16,95` |
| D4 | Portal `preflight:production` 只接受 `PPE/PROD` | Sandbox 无法复用该预检脚本 | Sandbox 验收用 `/api/health/config` + 逐项检查 |
| D5 | Portal 数据迁移 dry-run 只允许 `DEV`/`SIT` 前缀 | Sandbox 需手工执行或新增允许值 | 运维脚本处理 |
| D6 | Portal 尚未消费 Admin 课程投影（只拉分类） | Course Sandbox 的课程卡片/详情仍来自 Portal 自有数据 | 首期用 Portal 数据迁移过渡；集成另立项 |
| D7 | ~~Admin provision 脚本只支持 `dev/sit/uat`~~ | **本分支已修复**：`ADMIN_ENV=sandbox`（分支必传、`AUTH_ENABLED=true` 强制、AUTH_TOKEN 映射、sandbox 桶名、备份 7 天、关闭自动部署）。Portal 侧 provision 已在 Portal 工作区参数化（G7，待提交/部署验证） | `scripts/provision-admin-dev.mjs`；Portal 工作区 `scripts/provision-uat.mjs:66-111` |
| D8 | ~~脚本创建 `ADMIN_API_KEY`，服务端读 `AUTH_TOKEN`~~ | **本分支已修复**：`RuntimeEnvironmentSecrets.AUTH_TOKEN` 直接映射 `admin_api_key` secret ARN | `scripts/provision-admin-dev.mjs` |
| D9 | ~~Admin RDS 备份默认 1 天~~ | **本分支已修复**：Sandbox 为 7 天（其它环境保持历史 1 天） | `scripts/provision-admin-dev.mjs` |
| D10 | ~~Portal `scripts/release/environments.mjs` 只注册 DEV/SIT/UAT/PPE，未知环境抛 `Unknown release environment`~~ | **Portal 工作区已实现**（待提交/部署验证）：真正新增 SANDBOX 条目（不是别名）；未包含该修复的部署在 verify 阶段传 `environment: SANDBOX` 会直接失败 | Portal 工作区 `scripts/release/environments.mjs:47-62` |

## 7. 环境隔离核对表（Sandbox 建成后逐项验证）

| 维度 | Sandbox | 验收 |
|---|---|---|
| 数据库 | 独立 RDS 实例、独立库/账号 | UAT 凭据连 Sandbox DB 失败 |
| 对象存储 | 独立桶 + `learning-guide/sandbox` 前缀 | 跨环境前缀 AccessDenied |
| 密钥 | `learning-guide/sandbox/*`、`learning-guide/admin/sandbox/*` | 跨环境 secret 读取 denied |
| 服务鉴权 | 独立 `AUTH_TOKEN` | 跨环境 token 调 API 返回 401 |
| 域名/Cookie | `sandbox.*` / `admin.sandbox.*` | 会话 Cookie 不在其它域生效（host-only） |
| Stripe | 测试账号 + 独立 webhook | Checkout `livemode=false`；无 `sk_live_` |
| 内容通道 | 只允许 Sandbox → Production 的课程包 | 反向/跨环境导入被拒（Part C 接线并开 `on` 后） |
| 能力分区 | Admin 只起 `admin` 角色，且 `ADMIN_CAPABILITIES=course,accounts` | 非课程模块 API 404 `MODULE_NOT_ENABLED` + 菜单隐藏；Helpdesk/AI 变量未配置 |

## 8. 目标流程（能力/来源开关启用后）

1. Operator 在 **Sandbox** 创作并验证课程（前台 + Stripe 沙盒 + 播放复核）。
2. Sandbox 导出课程包。**当前基线（87e0be2）实际导出 v1 包**：`source.environment=Sandbox`、`sourceVersion=X.Y`，**不含 v2 provenance**；`provenance.sourceEnv` 与来源门按 owner 决定**不做**（v2/provenance 为范围外，交付以 v1 为准）。
3. Production（UAT）**只导入**该包 → plan preview/approve → Publish → Change status。
4. Production 禁止内容编辑/新建/结构变更（服务端 403 `CAPABILITY_DISABLED`）。
5. 每次生产发布后，`sandbox` 分支快进到该生产发布 SHA（UAT=当前生产，同码）；修复合入上游 dev 后随下一次生产发布进入 Sandbox。

## 附：参考文件

| 主题 | 位置 |
|---|---|
| PRD（Sandbox/Production 规则） | `docs/prd.md` §3.1、第 15 章 |
| 逻辑分区与分支契约 | `docs/sandbox/partitioning.md` |
| 资源申请单与搭建步骤 | `docs/sandbox/provisioning-request.md` |
| 验收清单 | `docs/sandbox/acceptance-checklist.md` |
| 环境变量模板 | `deploy/sandbox.example.env` |
| 部署工作流模板 | `deploy/admin-sandbox-deploy.yml.template` |
| 验收 smoke | `scripts/sandbox-smoke.mjs` |
