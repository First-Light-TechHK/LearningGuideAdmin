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
