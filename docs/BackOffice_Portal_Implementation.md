# BackOffice Portal 实现基准（P0）

> 单一事实来源：本文件描述 BackOffice Portal P0 的实现范围、分层与技术决策。
> 需求来源：`docs/Learning_Guide_BackOffice_Portal_PRD_v1_1_EN_UK.md`（PRD v1.1）。
> 分支：`feature/backoffice-portal`　目录：`backoffice/`

## 1. 范围

本基准只覆盖 PRD v1.1 中标记为 **P0** 的条目，P1/P2 不实现，也不为其预留结构。

| PRD 编号 | 功能 | 实现位置 | 状态 |
|---|---|---|---|
| PORT-P01 | 员工登录（Email Check + 密码 + 会话） | `app/[locale]/sign-in`、`app/api/auth/{email-check,sign-in}` | 已实现 |
| PORT-P02 | 激活链接设置初始密码 | `app/[locale]/activate`、`app/api/auth/activate` | 已实现 |
| PORT-P03 | 忘记密码 / 重置密码 | `app/[locale]/{forgot-password,reset-password}`、`app/api/auth/*-password` | 已实现 |
| PORT-P04 | 全局导航与外壳 | `components/AppShell.tsx`、`app/[locale]/(shell)/**` | 已实现 |
| PORT-P05 | 员工账号列表（搜索/筛选/分页） | `app/[locale]/(shell)/settings/employee-account` | 已实现 |
| PORT-P06 | 新建员工 + 发送激活邮件 | `app/api/admin/employees`（POST） | 已实现 |
| PORT-P07 | 编辑员工 / 重置密码 / 重发激活 | `app/api/admin/employees/[employeeId]/**` | 已实现 |
| PORT-P08 | 受保护管理员初始化 | `scripts/bootstrap-admin.mjs` + DB 触发器 | 已实现 |
| 修改密码 | 登录后自查改密并强制重新登录 | `app/api/auth/change-password`、`AppShell` 员工菜单 | 已实现 |
| RBAC | 六角色 × 8 菜单权限矩阵 | `modules/rbac/permissions.ts` + `modules/rbac/access.ts` | 已实现 |
| i18n | en-GB / zh-CN 切换 | `messages/*.json`、`lib/i18n/*`、`middleware.ts` | 已实现 |
| PORT-NAV-006 | 语言偏好跨登录保留 | `lib/localeCookie.ts`、`repositories/preferencesRepository.ts`、`app/api/preferences/locale` | 已实现 |
| PORT-NAV-003 | 侧栏折叠状态跨登录保留 | `app/api/preferences/sidebar` + `(shell)/layout.tsx` 读取 | 已实现 |
| PORT-ACT-003 | 过期 / 已使用链接区分 | `classifyTokenState` + `TOKEN_EXPIRED` / `TOKEN_ALREADY_USED` | 已实现 |
| 邮件投递 | SMTP → SES → DEV console 三级适配 | `modules/notification/services/email.ts` | 已实现 |

## 2. 技术栈（与 LearningGuidePortal 对齐）

- Next.js 15 App Router，页面与 API 同仓库同部署单元
- React 19 + TypeScript strict（含 `noUncheckedIndexedAccess`）
- PostgreSQL，驱动 `pg`，迁移为 `db/migrations/*.sql` 顺序执行
- 密码哈希：`node:crypto` scrypt（每账号独立盐），无外部依赖
- 令牌：随机 32 字节，落库只存 HMAC-SHA256

### 2.1 与 Admin 仓库既有规则的差异（已裁决项）

| 冲突 | Admin 旧规则 | 本模块采用 | 理由 |
|---|---|---|---|
| 表结构管理 | Prisma Migrate | `db/migrations/*.sql` | 技术栈改为 Next.js + pg，Prisma 规则只适用于既有 `server/` |
| 前端框架 | Vite + Ant Design（`client/`） | Next.js App Router | 与 Portal 一致；`client/` 不改造 |
| 业务层 | NestJS 模块 | `modules/*/services` | 同一分层思想，宿主不同 |

## 3. 分层与边界

```
Route Handler → contracts 校验 → 会话/权限 → modules/*/services → repositories → PostgreSQL
```

硬约束：

1. Route Handler **不写业务规则、不写 SQL**，只做解析/校验/取会话/调 service/返回信封
2. 业务规则只存在于 `modules/*/services`
3. SQL 只存在于 `repositories/`
4. 服务端是唯一权威：菜单可见性、员工账号页可见性、编辑范围均由服务端判定
5. 前端隐藏按钮不是安全边界

## 4. 关键业务规则落点

| PRD 规则 | 落点 |
|---|---|
| BR-PORT-002 邮箱大小写不敏感 | `normaliseEmail` + `login_email = lower(...)` 约束 |
| BR-PORT-004 三态状态 | `deriveDisplayStatus`，SQL 层等价展开用于筛选 |
| BR-PORT-005 仅 Active+Verified 可登录 | `isSignInEligible`（登录、会话解析、邮箱检查三处共用） |
| BR-PORT-006 Email Check 只对可登录账号给绿勾 | `checkEmployeeEmail` |
| BR-PORT-008 已验证邮箱不可改 | `updateEmployee`（服务层）+ 表单禁用（展示层） |
| BR-PORT-009 邮箱变更需重新验证 | 吊销旧令牌 + 向新地址重发激活 |
| BR-PORT-012 停用不改验证状态 | 只写 `account_status` |
| BR-PORT-013 停用立即吊销会话 | `revokeAllForEmployee`；会话解析时二次校验 |
| BR-PORT-017 默认落地 Course | `DEFAULT_LANDING_MENU` |
| BR-PORT-018 显示名取邮箱 @ 前缀 | `displayNameFromEmail` |
| PORT-EDT-006 受保护管理员不可降级/停用 | 服务层 + 数据库触发器双保护 |
| PORT-ACT-003 激活链接 48h / 单次 | `ACTIVATION_TOKEN_HOURS`、`consumeOnce`（条件更新） |
| PORT-SEC-006 令牌不可预测 / 单次 | 32 字节随机 + HMAC 落库 + 条件更新消费 |

## 5. 安全设计要点

- 会话 Cookie：httpOnly + SameSite=Lax + 生产态 Secure
- 双重超时：绝对 12h（`expires_at`）+ 空闲 30min（`last_seen_at`）
- 登录失败、邮箱检查、重发邮件、改密均有限流（固定窗口内存实现）
- 审计事件表带 CHECK 约束，禁止写入形如 `password=`/`token=` 的明文
- 忘记密码对外始终返回同一结果，避免账号枚举
- 写请求 CSRF：`middleware.ts` 校验 Origin/Host 一致性（SameSite=Lax 之外的第二道防线）
- 员工账号相关 API 统一走 `modules/rbac/adminGuard.ts`：无会话 401、非 Admin 403 并记 `permission_denied`

## 5.1 邮件投递

`modules/notification/services/email.ts` 与 LearningGuidePortal `services/emailService.ts` 保持相同的取值约定：

| 优先级 | 触发条件 | 行为 |
|---|---|---|
| 1 | `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` | nodemailer SMTP 投递（线上 163：`smtp.163.com:465`） |
| 2 | 仅 `SES_FROM_EMAIL` | AWS SESv2（默认 `ap-southeast-1`，实例角色授权） |
| 3 | 都没有 | DEV 打到服务端日志（`CONSOLE`）；其它环境返回 `NOT_CONFIGURED` |

发件人按 `SMTP_FROM` → `SES_FROM_EMAIL` → `SMTP_USER` 回退。
接口把真实投递结果（`SENT` / `CONSOLE` / `FAILED` / `NOT_CONFIGURED`）回显到列表页，
不再出现「已加入发送队列」这类不实提示（PORT-ADM-002）。

## 5. 视觉基准

页面风格与共享功能（语言切换、登录表单）以
`https://www.ilovelearningguide.com/zh-CN/portal` 为基准，生产 CSS 中的设计变量已直接采用：

| Token | 取值 | 用途 |
|---|---|---|
| `--color-primary` | `#0b63f6` | 主按钮、链接、导航激活 |
| `--color-primary-hover` | `#0757d8` | 悬停态 |
| `--color-primary-soft` | `#eaf2ff` | 激活项底色、焦点环 |
| `--color-text-main` | `#0b1437` | 正文 |
| `--color-text-muted` | `#5d6880` | 辅助文字 |
| `--color-border` | `#d9e2f1` | 描边 |
| `--color-page-bg` | `#f8fafe` | 页面底色 |
| `--color-sidebar` | `#eef1f6` | 侧边栏 |
| 字体 | `Inter, ui-sans-serif, system-ui, …` + 中文回退 | 全站 |
| 圆角 | 控件 8px / 卡片 12px / 胶囊 999px | 全站 |

共享组件的对齐点：

| 组件 | 基准站行为 | 本实现 |
|---|---|---|
| 语言切换 | 胶囊显示当前语言短名（`EN` / `中`），点击切到另一种 | `components/LocaleSwitch.tsx`，同一交互 |
| 登录页 | 深色背景图 + 居中白卡 + 邮箱优先两步 | `components/AuthLayout.tsx` + `[locale]/sign-in` |
| 认证页背景 | `/portal/auth-library.jpg` | 已复制到 `backoffice/public/portal/auth-library.jpg` |
| 返回链接 / 法律声明 | 「返回 Learning Guide Portal」+ 条款链接 | `AuthLayout` 的 `backHref` / `showLegal` |
| 顶部栏 | 品牌 + 语言胶囊 + 账号操作 | `AppShell` 的 `.header`（PORT-NAV-001 logo 顺带落地） |

有意保留的差异（因产品定位不同）：

- 基准站是学员门户，有「登录或创建账号」「Google / 微信登录」「开始学习」CTA；
  BackOffice 仅员工账号，**不提供自助注册与社交登录**，因此副标题明确写「不支持自助注册」。
- 基准站导航在顶部；BackOffice 按 PRD 使用左侧导航，只复用其配色与控件样式。
- logo 暂用 `LG` 文字块占位，设计侧提供 SVG 后替换。

## 6. 已知限制（须在验收时确认）

| 限制 | 影响 | 处置建议 |
|---|---|---|
| 限流为单实例内存实现 | 多实例部署时限流失效 | 上线前换共享存储（Redis/DB） |
| 邮件投递只有 console adapter | 生产态返回 `NOT_CONFIGURED`，不会伪装成功 | 接入 SES/SMTP 后再验收邮件链路 |
| PRD §8 原型图以 .docx 内嵌图片存在，仓库内 `md_assets/` 缺失 | 无法逐像素对齐后台原型 | 由用户提供 Figma/截图或补齐 `md_assets/` |
| Figma MCP 在本机未注入 agent 工具 | 无法读取设计上下文 | 见 `docs/AI_Collaboration_Log.md` 记录 |
| 视觉以学员门户为基准，非后台原型稿 | 若后台有专属设计稿仍需再对齐 | 拿到后台设计稿后复核 |
| logo 用 `LG` 文字块占位 | 与真实品牌标识不同 | 设计侧提供 SVG 后替换 |
| Actions 列为并列按钮，非 per-row 菜单（PORT-LST-005） | 交互形态差异 | 由视觉确认后再改 |
| Last Login 按 UTC 显示 | 非本地时区格式 | 需要时按 locale 格式化 |
| 无 CSRF token（依赖 SameSite=Lax） | 跨站表单受 Cookie 策略保护 | 如需强防护再加双提交令牌 |

## 6.1 工程参数取值（PRD §14.3 允许自定，需产品确认）

| 参数 | 取值 | 位置 |
|---|---|---|
| 密码长度 | 12–128 字符 | `lib/securityPolicy.ts` |
| 激活令牌有效期 | 48 小时（PRD 强制） | `ACTIVATION_TOKEN_HOURS` |
| 重置令牌有效期 | 2 小时 | `RESET_TOKEN_HOURS` |
| 会话绝对超时 | 12 小时 | `SESSION_MAX_HOURS` |
| 会话空闲超时 | 30 分钟 | `SESSION_IDLE_MINUTES` |
| 登录限流 | 5 分钟内 10 次 / IP | `SIGN_IN_MAX_PER_WINDOW` |
| 发信限流 | 5 分钟内 5 次 / IP | `EMAIL_SEND_MAX_PER_WINDOW` |
| 列表分页 | 默认 10，上限 100 | `EMPLOYEE_PAGE_SIZE_*` |

## 7. 验收方式

```bash
cd backoffice
npm run typecheck && npm run lint && npm run test:unit && npm run build
```

自动化测试覆盖（`tests/unit`，共 44 项）：

| 文件 | 覆盖 |
|---|---|
| `access.test.ts` | 未登录 401 语义、非 Admin 403 语义、六角色菜单守卫 |
| `verificationTokens.test.ts` | 令牌五态判定与优先级、错误码映射（PORT-ACT-003） |
| `employee.test.ts` | 三态派生、登录资格、邮箱规范化、角色清单 |
| `password.test.ts` | scrypt 往返、错误密码、盐唯一、畸形哈希不抛异常 |
| `rateLimit.test.ts` | 阈值、`retryAfter`、按 key 隔离 |
| `envelope.test.ts` | 信封形状、HTTP 状态映射、错误码全覆盖 |

HTTP 层实测（2026-10-22，本地 dev + 真实 PostgreSQL）：

```
GET  /                          → 307 跳 /en-GB
GET  /en-GB/course（未登录）      → 307 跳登录
GET  /api/admin/employees（未登录）→ 403
email-check 管理员 / 未知邮箱      → eligible=true / false
sign-in 错误密码 / 正确密码        → 401 / 200+Set-Cookie
GET  /api/admin/employees（已登录）→ 200 真实数据
创建重复邮箱                      → 409
sign-out → 再访问受保护页          → 307（会话已吊销）
过期激活令牌                      → 410 TOKEN_EXPIRED
重复使用激活令牌                   → 410 TOKEN_ALREADY_USED
偏好存 zh-CN 后重新登录            → 返回 zh-CN
GET  /api/session                → landing=/en-GB/course
```

人工验收（浏览器操作由用户执行）：

1. 无会话访问 `/en-GB/course` → 跳转 sign-in
2. 非 Admin 直接输入 `/en-GB/settings/employee-account` → 无权提示
3. 非 Admin 直接输入 `/zh-CN/knowledge`（如 Operation Admin）→ 无权提示
4. 停用某员工后其已有会话立即失效
5. 点专用激活链接过期/已用 → 看到不同提示文案
6. 切到中文后退出再登录 → 仍为中文

