# Admin DEV stack (provisioned 2026-10-23)

Facts verified against AWS account 851987565851, ap-southeast-1.

| Resource | Value |
|---|---|
| RDS | `learning-guide-admin-dev`, db `learning_guide_admin_dev`, user `lg_admin_dev`, PostgreSQL 16.13, SG `sg-008ed73655a0143db` |
| Secrets | `learning-guide/admin/dev/database_url`, `learning-guide/admin/dev/admin_api_key` |
| Instance role | `learning-guide-admin-dev-runtime` (read the two secrets) |
| App Runner | `learning-guide-admin-dev`, ARN `arn:aws:apprunner:ap-southeast-1:851987565851:service/learning-guide-admin-dev/caab5bd61545487093ef0150c9981755`, URL `https://cpzmzuzkkj.ap-southeast-1.awsapprunner.com` |
| SPA bucket | `learning-guide-admin-dev-851987565851` (private, CloudFront OAC `EYCR5ABSMN9M9`) |
| CloudFront | `E2E9K78VZ45X8U`, `d5twyee4s494s.cloudfront.net` |
| ACM (us-east-1) | `arn:aws:acm:us-east-1:851987565851:certificate/22c4d81e-276b-425e-b78b-a8000bb30165` for `admin.ilovelearningguide.com` |
| Repo variable | `ADMIN_DEV_APP_RUNNER_SERVICE_ARN` = the App Runner ARN above |

## Routing

- Single service: the NestJS app serves both the API and the built BackOffice UI
  (`client/dist`, via `serveBackOfficeUi()` in `server/src/main.ts`). One App Runner service, one build,
  one deploy; there is no separate frontend server and no S3-hosted SPA.
- `/api/*` goes to the NestJS router; every other GET/HEAD returns `index.html` with `Cache-Control: no-store, no-cache, must-revalidate` (including a direct request to `/index.html`).
  Hashed assets under `/assets/*` are immutable for 1 year.
- CloudFront (optional edge) puts App Runner behind the alias; caching disabled, `Managed-AllViewerExceptHostHeader`.
  The origin must stay the App Runner domain: the service returns 404 for unknown viewer hosts.
  The Host header must stay the App Runner domain: the service returns 404 for unknown viewer hosts,
  so do not switch this policy back to `Managed-AllViewer`.
- The SPA calls `baseURL: '/api'`, so it works on any host CloudFront is reached through.

## Start command

App Runner does not run StartCommand through a shell, so shell operators live in `start-admin.sh`:
`sh ./start-admin.sh` → `npx prisma migrate deploy` → `node dist/main`.

## Health

`GET /api/health` is public (the API-key guard skips it) and returns
`{"status":"ok","service":"learning-guide-admin","environment":"DEV"}`.

## Pending

- ACM validation CNAME for `admin.ilovelearningguide.com` must be added by the DNS owner.
- Add the alias + certificate to the distribution, upload the client build, then point the `admin` CNAME at `d5twyee4s494s.cloudfront.net`.

## Publishing

Nothing separate to publish: a push to `dev` rebuilds `client/dist` and `server/dist` in the same App Runner build.

## Continuous deploy

- `.github/workflows/dev-deploy.yml` must exist on `main`: GitHub only registers `workflow_run`
  triggers from the default branch, so a copy kept only on `dev` never fires.
- Repo secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` belong to IAM user
  `learning-guide-admin-ci`, whose only permission is `apprunner:StartDeployment`,
  `DescribeService` and `ListOperations` on the DEV service ARN.
- Chain: push to `dev` → CI → Deploy DEV → App Runner source build → `/api/health`.

## Environment files

The merged Admin app (NestJS `server/` + Vite `client/`) reads configuration from:

- Local development: `server/.env` (copy from `server/.env.example`). The Vite client has no env file; it proxies
  `/api` to `http://localhost:3000`.
- Deployed DEV: App Runner `RuntimeEnvironmentVariables` plus Secrets Manager ARNs, written by
  `scripts/provision-admin-dev.mjs`.

### AI Tutor runtime secrets (DEV)

App Runner source deployments rebuild code but keep the service configuration, so `server/.env` is never read in
the cloud. The tutor needs two values that the provisioning script cannot invent:

| Repository variable | App Runner key | Where the value lives |
|---|---|---|
| `OPENROUTER_API_KEY_SECRET_ARN` | `RuntimeEnvironmentSecrets.OPENROUTER_API_KEY` | Secrets Manager |
| `AI_CONFIG_ENCRYPTION_KEY_SECRET_ARN` | `RuntimeEnvironmentSecrets.AI_CONFIG_ENCRYPTION_KEY` | Secrets Manager (64 hex chars) |
| `AI_AVAILABLE_MODELS` (optional) | `RuntimeEnvironmentVariables.AI_AVAILABLE_MODELS` | repository variable |

Without `OPENROUTER_API_KEY` a learner request fails with "未配置可用的 LLM API Key"; without
`AI_CONFIG_ENCRYPTION_KEY` a course-level key cannot be saved or decrypted. The deploy workflow merges these keys
with `scripts/configure-admin-dev-env.mjs` before `start-deployment` as soon as either ARN variable exists; if
only one is set the script fails loudly instead of leaving a half-configured pair. Required IAM: the CI user needs
`apprunner:UpdateService` on this service, and the instance role needs `secretsmanager:GetSecretValue` on both
secrets. Future provisioning can pass the ARNs to `provision-admin-dev.mjs`; never pass secret values through the
repository or GitHub.

`backoffice/.env.local` is a leftover from the retired standalone Next.js prototype (`backoffice/`, port 3200).
It is gitignored, is not read by the merged app, and can be deleted. It contains only
`DATABASE_URL`, `SESSION_SECRET`, `APP_ENV`, `NEXT_PUBLIC_APP_URL`, `BOOTSTRAP_ADMIN_*` and an empty
`SES_FROM_EMAIL` — no SMTP settings.

## Email (BackOffice notifications)

Adapter: `server/src/backoffice/modules/notification/services/email.ts` — SMTP when `SMTP_HOST` + `SMTP_USER` +
`SMTP_PASS` are present, otherwise Amazon SES v2 (`SES_FROM_EMAIL`, region `ap-southeast-1`), otherwise the
console adapter on DEV. Delivery failures return `FAILED`. Admin-triggered create / resend / reset calls always
hand the single-use activation or reset link back to the operator (even when the email was sent), so the page can
offer a copy button when the recipient cannot open the mailbox.

Current DEV configuration:

- `SMTP_HOST=smtp.163.com`, `SMTP_PORT=465`, `SMTP_SECURE=1`, `SMTP_USER=learningguide@163.com`,
  `SMTP_FROM=Learning Guide <learningguide@163.com>`, `SMTP_PASS` from `learning-guide/admin/dev/smtp_pass`.
- `SES_FROM_EMAIL=learningguide@163.com` is set as the AWS fallback; the instance role has
  `ses:SendEmail` on that identity.

AWS SES state (2026-10-25): account is **in the sandbox** in every region, so SES can only deliver to
verified addresses (`yongthelaoma@gmail.com`, `learningguide@163.com`). To use SES for real employees:

1. Publish the three DKIM CNAMEs for `ilovelearningguide.com` (`<token>._domainkey` → `<token>.dkim.amazonses.com`).
2. Request production access in the SES console (Account dashboard → Request production access).
3. Then set `SES_FROM_EMAIL=no-reply@ilovelearningguide.com` and remove the SMTP variables.

Until then SMTP is the working path; SES remains the target for production.

---

# Sandbox 从生产版本晋级

两仓的 `sandbox` 分支 push 自动触发 `Deploy Sandbox`；也可在该分支手动运行并提供完整生产版本 SHA。`dev` push 不触发。流程只读取生产服务，更新 Sandbox App Runner 的镜像来源；不会移动或重写 Git 分支。修改只适用于新 workflow，现有 DEV/SIT/UAT/PPE 流程不变。

## 启用前置条件

1. 仓库启用受保护的 `sandbox` GitHub Environment，限定部署分支与可信审批人；仅可信发布负责人可维护环境变量、密钥和 workflow。AWS 权限应只允许读取指定生产服务、只更新指定 Sandbox 服务及读取所需 ECR；不要给予生产更新权限。
2. 生产服务必须 RUNNING、最新 App Runner 操作成功，运行的 ImageRepository 指向不可变 `@sha256:` 镜像，生产运行配置 APP_ENV 为允许的生产环境值。Sandbox 服务必须名为 `learning-guide-sandbox`（Admin 为 `learning-guide-admin-sandbox`），是 RUNNING 的镜像服务，配置 APP_ENV=SANDBOX、自动部署关闭，当前镜像也是不可变摘要。两服务 ARN 必须不同，Sandbox 有拉取新旧镜像权限。现有 source branch + start-deployment 无法保证 App Runner 实际拉取的精确 commit；它不满足本门禁，负责人确认单独不能解决目标部署的 SHA 漂移。需先以可核验方式把生产和 Sandbox 迁移为不可变镜像服务并保留旧镜像。
3. 受保护 Environment 中的 `PRODUCTION_SOURCE_REF` 必须明确指定可信生产来源分支；被晋级 SHA 必须是该分支当前精确 40 位 HEAD。自动触发使用受保护的 `PRODUCTION_RELEASE_SHA`，手动触发提供 `release_sha`；该 SHA 的规定 push CI 及所有必需 job 必须成功，新失败或运行中的最新重跑会阻止发布。
4. 生产镜像与 SHA 的绑定必须有下列任一证据：GitHub 对该 OCI 摘要的 SLSA attestation，由受保护变量 `PRODUCTION_SIGNER_WORKFLOW` 指定的可信 workflow 签发，来源 ref 和 SHA 匹配；或可信生产发布负责人核对构建、成功生产操作和正在运行的摘要后，在受保护 `sandbox` environment 维护 `PRODUCTION_CONFIRMED_SHA` 和 `PRODUCTION_CONFIRMED_IMAGE`，二者必须同时精确匹配。负责人确认属于人工信任路径，应保留确认人、时间、生产操作 ID、CI 链接和构建证据；不得仅按分支名或操作成功推断 SHA。当前两仓生产流水线尚无此镜像及签名保证，不应假设已具备。
5. 配置 environment variables：`PRODUCTION_SOURCE_REF`、`PRODUCTION_RELEASE_SHA`、可选的 `PRODUCTION_SIGNER_WORKFLOW`、`PRODUCTION_SERVICE_NAME`、`PPE_APP_RUNNER_SERVICE_ARN`、`SANDBOX_APP_RUNNER_SERVICE_ARN`、`SANDBOX_ORIGIN`；Admin 使用 `ADMIN_PPE_APP_RUNNER_SERVICE_ARN`、`ADMIN_SANDBOX_APP_RUNNER_SERVICE_ARN`、`ADMIN_SANDBOX_ORIGIN`。确认 origin 指向 Sandbox。配置只用于该环境的 AWS 凭据；OCI provenance 检查需要 ECR/GitHub attestation 读取权限。生产 workflow 将来改名时需同步固定 signer 策略并复核信任边界。

发布前流程读取生产和 Sandbox 状态、验证证据，更新前复查两边配置；更新仅替换 Sandbox 的 image digest 和 APP_VERSION，保留其环境变量、密钥引用和身份配置。App Runner 操作成功后复查目标 digest，再检查 Sandbox 健康。Portal 使用现有 live smoke；Admin 仅检查健康及环境，完整业务验收仍需另行执行。健康或部署失败时，若服务已稳定且其完整来源配置与本次目标一致（忽略对象键顺序），恢复原 Sandbox 来源并等待操作结果；若服务仍忙或被他人变更，不覆盖其状态，报错交运维处理。失败始终使 workflow 失败。CLI 请求结果不确定时不能假定未发生写入，应先检查 App Runner 操作与来源，再手工决定恢复。

本地离线验证：Admin `node --test scripts/sandbox-promotion.test.mjs`，Portal `node --test tests/unit/sandbox-release-policy.test.mjs`。这只验证策略和回退决策，不构成 AWS、签名服务、实时健康或实际回滚演练。启用前应由运维在隔离账户演练正反例、权限及失败恢复。
