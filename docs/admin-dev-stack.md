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
- `/api/*` goes to the NestJS router; every other GET/HEAD returns `index.html` with `Cache-Control: no-cache`.
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
