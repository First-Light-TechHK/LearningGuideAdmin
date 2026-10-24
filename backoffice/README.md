# BackOffice Portal (P0)

Learning Guide 后台管理门户，按 `docs/Learning_Guide_BackOffice_Portal_PRD_v1_1_EN_UK.md` 实现。

技术栈：**Next.js 15 App Router + React 19 + TypeScript(strict) + PostgreSQL(pg)**，
与 `LearningGuidePortal` 保持一致；`client/` 与 `server/` 不改动。

## 快速开始

```bash
cp .env.example .env.local     # 填入 DATABASE_URL 与 SESSION_SECRET
npm install
npm run db:migrate             # 建表
npm run bootstrap:admin        # 初始化受保护管理员
npm run dev                    # http://localhost:3200
```

## 邮件投递（激活 / 重置密码 / 改密通知）

取值与 `LearningGuidePortal` 的 `services/emailService.ts` 一致，按顺序生效：

1. **163 SMTP（线上默认）**——`SMTP_HOST=smtp.163.com`、`SMTP_PORT=465`、`SMTP_SECURE=1`、
   `SMTP_USER=<邮箱>`、`SMTP_PASS=<授权码>`，可选 `SMTP_FROM`（留空回退 `SMTP_USER`）
2. **AWS SESv2（备用）**——只配 `SES_FROM_EMAIL`，区域取 `AWS_REGION`（默认 `ap-southeast-1`），
   凭据由实例角色提供
3. **DEV 无配置**——邮件正文打到服务端日志（`[notification:console]`），接口返回 `CONSOLE`

三者都没有且非 DEV 时接口返回 `NOT_CONFIGURED`，前端如实提示「未发送（邮件服务未配置）」，
不会伪装成已发送（PORT-ADM-002）。`EMAIL_DELIVERY=discard|fail` 可用于联调。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run build` | 生产构建 |
| `npm run typecheck` | TypeScript 严格检查 |
| `npm run test:unit` | 单元测试（node:test） |
| `npm run db:migrate` | 顺序执行 `db/migrations/*.sql` |
| `npm run bootstrap:admin` | 创建/轮换受保护管理员 |

## 目录职责

```
app/                   页面与 Route Handler（只做解析/校验/取会话/调 service/返回）
components/            外壳与交互组件
contracts/             前后端共享类型与响应信封（success/data/error/message）
modules/               业务规则（rbac / user-authentication / employee-account / notification）
repositories/          唯一允许写 SQL 的地方
db/migrations/         版本化迁移（禁止手改数据库）
messages/              en-GB / zh-CN 文案
lib/                   env / db / http / 限流 / 安全策略 / 会话读取
```

## P0 覆盖

| PRD | 实现位置 |
|---|---|
| PORT-P01 Employee Sign In | `app/[locale]/sign-in`, `app/api/auth/{email-check,sign-in}` |
| PORT-P02 Set Password / Activate | `app/[locale]/activate`, `app/api/auth/activate` |
| PORT-P03 Forgot / Reset Password | `app/[locale]/{forgot-password,reset-password}`, `app/api/auth/{forgot,reset}-password` |
| PORT-P04 Global Navigation | `components/AppShell.tsx`, `app/[locale]/(shell)/**` |
| PORT-P05~P07 Employee Account | `app/[locale]/(shell)/settings/employee-account`, `app/api/admin/employees/**` |
| PORT-P08 Bootstrap Admin | `scripts/bootstrap-admin.mjs` + 数据库触发器 |
| RBAC 六角色矩阵 | `modules/rbac/permissions.ts` |
| 会话与安全 | `modules/user-authentication/services/session.ts`, `lib/securityPolicy.ts` |
| 邮件投递三级适配 | `modules/notification/services/email.ts` |
| 侧栏折叠状态持久化 | `app/api/preferences/sidebar`, `app/[locale]/(shell)/layout.tsx` |

## 开发纪律

- Route Handler 不写业务规则、不写 SQL
- 表结构变更只通过 `db/migrations` 新增文件
- 令牌只存 HMAC，密码只存 scrypt 哈希
- 新增文案必须同时补 `en-GB` 与 `zh-CN`
- 改完跑 `npm run typecheck && npm run test:unit && npm run build`
