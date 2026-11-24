# AWS 就绪手册（拿到凭据后照做）

> 目标：在 ops 批准并发放 AWS 访问后，本仓库内的一切准备物可**当天**按顺序执行，把 Sandbox 拉起来。
> 现状约束：本文编写时未调用任何 AWS API、未创建任何资源；文中所有命令都是"拿到凭据后执行"的步骤，任何一步跑之前先核对账号身份。
> 来源：2026-11-19 从 LearningGuideSandbox 仓库 `docs/aws-readiness.md` 合并进 Admin 仓库（F4 合并完整性），并按 Admin 分支 `feat/sandbox-provisioning`（基线 `origin/dev` 87e0be2）的当前实现同步（provision 脚本已支持 `ADMIN_ENV=sandbox`；Portal 侧前置在 Portal 工作区实现，待提交/部署验证）。
> 关联：`docs/sandbox/provisioning-request.md`（资源清单、验收与代码缺口 §6）、`docs/sandbox/acceptance-checklist.md`（验收）、`docs/sandbox/partitioning.md`（分区与分支契约）。

---

## 1. 待获取的访问（交给 ops 的清单）

| # | 访问项 | 用途 | 最小权限 | 验证（拿到后） |
|---|---|---|---|---|
| 1 | 控制台/CLI 执行者身份 | 部署 CFN、建 App Runner、写 Secrets | 建议 IAM 角色或 SSO 用户：CloudFormation 部署 `learning-guide-sandbox` 栈、Secrets Manager 写 `learning-guide/sandbox/*` 与 `learning-guide/admin/sandbox/*`、App Runner 建/更两服务 | `aws sts get-caller-identity` 输出与 ops 告知的 ARN 一致 |
| 2 | CI 用户（两个 fork 仓库各一或共用一个） | GitHub Actions 发布 sandbox | 模板：`deploy/ci-iam-policy.json.template`（填 `<ACCOUNT_ID>` 与两服务 `<SERVICE_ID>` 后由 ops 挂到用户） | 工作流 `configure-aws-credentials` 步骤能取到凭证且 `describe-service` 成功 |
| 3 | 只读审计身份（可选） | 验收 B2–B4 的 IAM 模拟与截图 | `iam:SimulatePrincipalPolicy`、只读相关 | Policy Simulator 可跑 |
| 4 | Stripe 测试账号、Google/WeChat 控制台、OpenRouter、163 SMTP 授权码 | 由产品/付款负责人提供，直接给 ops 注入 Secrets，不经仓库 | — | Secrets 创建后 `describe-secret` 存在、值不回显 |
| 5 | DNS 发布权限确认 | 两个域名记录 | DNSPod 客户侧 | §2.6 |

**本地准备（执行者机器）**

```bash
# 仅一次性配置；凭据不入仓库、不入 .env（.gitignore 已覆盖）
aws --version                                          # 需 AWS CLI v2
aws configure --profile learning-guide-sandbox         # Access Key + Secret（或 SSO：aws configure sso）
aws --profile learning-guide-sandbox sts get-caller-identity
# 期望输出账号 = ops 批准的账号（Q1 决策结果）；region 一律 ap-southeast-1
```

安全底线：MFA 必须开启；access key 只放 `~/.aws/credentials`（chmod 600）；任何命令不 `echo` 密钥；日志脱敏。

---

## 2. Day-0 执行顺序（拿到凭据当天）

### 2.1 身份与前置核对

```bash
aws --profile learning-guide-sandbox sts get-caller-identity
# 1) 账号 = Q1 决策结果  2) 有 us-east-1 之外的 ap-southeast-1 访问
aws --profile learning-guide-sandbox ec2 describe-vpcs --region ap-southeast-1 --query 'Vpcs[].VpcId'
# 3) 确认目标 VPC 存在；4) 确认 172.31.68/69 两个 /24 空闲（SIT 64/65、UAT 66/67）
aws --profile learning-guide-sandbox ec2 describe-subnets --region ap-southeast-1 \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`].SubnetId'
# 5) 挑一个公有子网给 NAT（模板参数 NatSubnetId）
```

### 2.2 部署基础设施栈（Portal Sandbox 网络/库/桶/角色）

```bash
aws --profile learning-guide-sandbox cloudformation deploy \
  --region ap-southeast-1 --stack-name learning-guide-sandbox \
  --template-file deploy/sandbox-infrastructure.yml \
  --parameter-overrides VpcId=<VPC_ID> NatSubnetId=<PUBLIC_SUBNET_ID> \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags Project=LearningGuide Environment=Sandbox

aws --profile learning-guide-sandbox cloudformation describe-stacks \
  --region ap-southeast-1 --stack-name learning-guide-sandbox \
  --query 'Stacks[0].Outputs'
# 记下 DatabaseHost / MasterSecret / ConnectorArn / AppRoleArn / ScalingArn / BucketName
```

与 `provisioning-request.md` §5 1.1–1.5 的验收逐项对应（RDS 私有加密、S3 四块、IAM 模拟跨环境 denied）。

### 2.3 注入 Secrets（值只经 Secrets Manager，不经仓库/日志）

按 `provisioning-request.md` §3.4 的命名创建，示例（每条真实值由 ops/产品提供，勿在聊天记录粘贴）：

```bash
aws --profile learning-guide-sandbox secretsmanager create-secret \
  --region ap-southeast-1 \
  --name learning-guide/sandbox/session_secret \
  --secret-string "$(openssl rand -base64 48)" \
  --tags '[{"Key":"Environment","Value":"Sandbox"}]'
```

需要创建的全部列表见 `deploy/sandbox.example.env` 中所有 `<secret-ref:…>` 行；来源对照表：

| Secret | 来源 |
|---|---|
| `*/database_url` | 2.2 的 MasterSecret 恢复出的主密码 + 自建应用账号（参照 UAT `lg_uat_app` 做法） |
| `*/session_secret`、`*/portal_preview_secret`、`admin/*/ai_config_encryption_key`（64 hex，首期不启用时可不建） | 执行时用 openssl 随机生成 |
| `*/stripe_secret_key`、`*/stripe_webhook_secret` | 付款负责人（测试账号） |
| `*/google_client_secret`、`*/wechat_app_secret` | 产品（对应 E2/E3 申请的应用） |
| `*/smtp_pass` | ops（163 授权码，Q4 决策） |
| `admin/sandbox/admin_api_key` | 随机生成；**部署时映射为 App Runner 的 `AUTH_TOKEN`（G11）** |
| `admin/sandbox/bootstrap_admin_password` | 执行者设定，仅用于建首个 Operator |

> 能力分区（owner 2026-11-16）：Helpdesk / AI Tutor / Study Group 首期不启用，`openrouter_api_key`、`ks_service_token`、`portal_helpdesk_token`、`admin_helpdesk_token`、`portal_integration_token`、`study_group_token_log_key` **不创建、不写入**（见 `deploy/sandbox.example.env` 第三部分）。

### 2.4 创建 Admin Sandbox App Runner

provision 脚本已支持 `ADMIN_ENV=sandbox`（本分支，S2/D7 已修复）：

```bash
ADMIN_ENV=sandbox ADMIN_BRANCH=sandbox AUTH_ENABLED=true \
VPC_ID=… SUBNET_IDS=… SECURITY_GROUP_ID=… GITHUB_CONNECTION_ARN=… \
INSTANCE_ROLE_ARN=… VPC_CONNECTOR_ARN=… \
COURSE_MEDIA_BUCKET=learning-guide-admin-sandbox-course-<acct> \
node scripts/provision-admin-dev.mjs --apply
```

脚本在 `ADMIN_ENV=sandbox` 时自动落实（均无需再手工补配置）：

- `ADMIN_BRANCH` 必传（无缺省分支）；`AutoDeploymentsEnabled=false`（发布只走 `deploy/admin-sandbox-deploy.yml.template`）；
- `AUTH_ENABLED=true` 强制校验，`RuntimeEnvironmentSecrets.AUTH_TOKEN` ← `admin_api_key` secret ARN（G11/D8）；
- 课程桶缺省为 `learning-guide-admin-sandbox-course-<acct>`，RDS 备份保留 7 天（G12/D9）；
- 显式写入 `APP_ROLES=admin`、`ADMIN_CAPABILITIES=course,accounts`、`ENVIRONMENT_LABEL=Sandbox`、`VERSION_NUMBERING_MODE=sandbox`（F3b；dev/sit/uat 保持历史行为）。
- 脚本**不自建**运行时角色与课程桶：`INSTANCE_ROLE_ARN`、`COURSE_MEDIA_BUCKET`/`COURSE_PACKAGE_BUCKET` 是输入参数，需 ops 先建；Helpdesk 首期不启用时，运行时不需授权 `learning-guide/sandbox/` 下的 helpdesk 令牌。

先跑不带 `--apply` 的 dry run 核对资源名（该路径只打印计划、不调用任何 AWS API）。

备选手工路径：控制台按 `provisioning-request.md` §2.2 A5 的参数建（构建/启动命令、端口 3000、健康检查 `/api/health`），变量与 Secrets 按 `deploy/sandbox.example.env` 第二部分注入（其中四项沙箱缺省与上面脚本一致）。

完成后验收 §5 Phase 2 全部步骤（health=SANDBOX、分类 4 个、徽标紫色、版本 `1.1`→`1.2`→`2.1`、能力分区 404）。

### 2.5 创建 Portal Sandbox App Runner

- 脚本路径：Portal 工作区已把 `scripts/provision-uat.mjs` 参数化为 sandbox tier（`PORTAL_ENV=sandbox`，含 `PORTAL_ENV=sandbox node scripts/provision-uat.mjs --bootstrap/--deploy`；见 `/Users/nihao/AI infra/LearningGuidePortal/scripts/provision-uat.mjs:66-111`），待提交/部署验证。`--bootstrap` 在缺 `deploy/sandbox-bootstrap.cjs` 时于任何 AWS 调用前 fail-closed。
- 手工路径：参数按 `provisioning-request.md` §2.1 P9（端口 8080、`/api/health`），变量按 `deploy/sandbox.example.env` 第一部分。
- ⚠ 部署工作流（`deploy/portal-sandbox-deploy.yml.template`）的 verify 阶段依赖 Portal `scripts/release/environments.mjs` 注册 SANDBOX（D10）：Portal 工作区已实现（`/Users/nihao/AI infra/LearningGuidePortal/scripts/release/environments.mjs:47-62`），待提交/部署验证；未包含该修复的部署会抛 `Unknown release environment`。

### 2.6 DNS 与 HTTPS

```bash
aws --profile learning-guide-sandbox apprunner describe-custom-domains \
  --region ap-southeast-1 --service-arn <PORTAL_SERVICE_ARN>
# 把返回的 CNAME 与验证记录原样交给 DNS 负责人；等状态 active 后再做 2.8
```

### 2.7 仓库变量与 CI 用户

按 `provisioning-request.md` §4 设置两 fork 的变量/密钥；把 `deploy/ci-iam-policy.json.template` 填好交给 ops 挂到 CI 用户；把两个 workflow 模板（`deploy/admin-sandbox-deploy.yml.template`、`deploy/portal-sandbox-deploy.yml.template`）复制进对应仓库。注意：模板替代的是 provision/deploy 脚本改动（G5），**不替代 Portal 代码前置**（`isManagedEnvironment()` 识别 SANDBOX、`release/environments.mjs` 注册 SANDBOX 条目，见 D3/G6/D10）。

### 2.8 验收

```bash
PORTAL_ORIGIN=https://sandbox.ilovelearningguide.com \
ADMIN_ORIGIN=https://admin.sandbox.ilovelearningguide.com \
ADMIN_SESSION_COOKIE='<登录后取>' \
node scripts/sandbox-smoke.mjs
```

再按 `docs/sandbox/acceptance-checklist.md` 的 B1–B9 完成手工核对。**全部通过才算 Sandbox 可用。**

---

## 3. 之后每个发布周期的例行项

| 项 | 动作 |
|---|---|
| 代码同步（S1/Q7） | 每次 Production 发版后，`sandbox` 分支快进到该生产发布 SHA（UAT=当前生产，同码），发布记录登记；修复合入上游 dev 后，随下一次生产发布进入 sandbox |
| 数据重置（Q5） | 按产品确认的频率执行 `sandbox-reset-learners`（G9 落地后）；课程内容保留 |
| 备份 | Admin RDS 7 天 PITR + 每次导出课程包（导出即备份） |
| 成本 | 月度 Cost Explorer 核对（参考：SIT 约 USD 80–100/月含 NAT；Sandbox 预估 USD 110–170/月 + 媒体存储） |

---

## 4. 附：`provision-uat.mjs` → sandbox tier 改造清单（Portal 工作区已按此参数化，待提交/部署验证）

| # | 项 | UAT 现状 | Sandbox 改法 |
|---|---|---|---|
| 1 | 栈名/服务名 | `learning-guide-uat` | `learning-guide-sandbox` |
| 2 | origin | `https://uat.ilovelearningguide.com` | `https://sandbox.ilovelearningguide.com` |
| 3 | 课程导入 | 从 SIT 导出课程（Lambda + 临时角色） | **删除整段**：Sandbox 内容由 Operator 在 Admin 创作，不从任何环境导入 |
| 4 | 凭据来源 | 从 SIT 服务配置复制 | 从执行者环境变量读取（`SANDBOX_GOOGLE_CLIENT_SECRET` 等），写 Secrets，不回显 |
| 5 | `APP_ENV` / 前缀 | `UAT` / `learning-guide/uat` | `SANDBOX` / `learning-guide/sandbox` |
| 6 | `STRIPE_SANDBOX` | `1` | `1`（不变）；`sk_test_` 校验保留 |
| 7 | 保留 | `DATABASE_CA_FILE`、`STORAGE_BACKEND=postgresql`、`PAYMENT_MODE=stripe`、`LOCAL_SOCIAL_LOGIN=0` | 不变 |
| 8 | bootstrap Lambda | 建 `product_payment_keys`/`orm_runtime` 表 | 保留（表结构需要）；需先有 `deploy/sandbox-bootstrap.cjs`（外部前置，缺失时脚本在 AWS 调用前 fail-closed） |
| 9 | 媒体 archive 只读策略 | 读 `aitutor-data` 旧桶 | **不要**（隔离要求，见 CFN 模板说明） |
| 10 | Admin provision 的默认值 | — | **已在本分支脚本内解决**：`ADMIN_ENV=sandbox` 无缺省分支、`AutoDeploymentsEnabled=false`、`-sandbox-` 桶名、`AUTH_ENABLED=true` 强制、`AUTH_TOKEN` 映射、能力分区四项显式写入（见 §2.4） |

---

> 红线复核：本手册中所有 AWS 命令均为"拿到凭据后"的执行步骤，本仓库从未运行过它们；未创建任何 AWS 资源、未提交任何密钥。
