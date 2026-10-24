# BackOffice Portal 实现基准（P0）

> 单一事实来源：本文件描述 BackOffice Portal P0 的实现范围、分层与技术决策。
> 需求来源：`docs/Learning_Guide_BackOffice_Portal_PRD_v1_1_EN_UK.md`（PRD v1.1）。
> 2026-10-23：原 `feature/backoffice-portal` 分支上的独立 Next.js 应用（`backoffice/`）已并入 Admin 本体，
> 与 KS（Knowledge）、AI Tutor 成为同一个应用：同一个 NestJS 服务端、同一个 Vite 前端、同一个数据库、同一套登录与权限。

## 1. 范围

本基准只覆盖 PRD v1.1 中标记为 **P0** 的条目，P1/P2 不实现，也不为其预留结构。

| PRD 编号 | 功能 | 实现位置 | 状态 |
|---|---|---|---|
| PORT-P01 | 员工登录（Email Check + 密码 + 会话） | `client/src/backoffice/pages/SignInPage.tsx`、`server/src/backoffice/nest/auth.controller.ts` | 已实现 |
| PORT-P02 | 激活链接设置初始密码 | `pages/ActivatePage.tsx`、`POST /api/auth/activate` | 已实现 |
| PORT-P03 | 忘记密码 / 重置密码 | `pages/{ForgotPassword,ResetPassword}Page.tsx`、`POST /api/auth/*-password` | 已实现 |
| PORT-P04 | 全局导航与外壳 | `client/src/backoffice/components/AppShell.tsx`、`ShellRoute.tsx`、`client/src/App.tsx` 路由 | 已实现 |
| PORT-P05 | 员工账号列表（搜索/筛选/分页） | `pages/EmployeeAccountPage.tsx`、`GET /api/admin/employees` | 已实现 |
| PORT-P06 | 新建员工 + 发送激活邮件 | `POST /api/admin/employees` | 已实现 |
| PORT-P07 | 编辑员工 / 重置密码 / 重发激活 | `PATCH /api/admin/employees/:id`、`POST .../{reset-password,resend-activation}` | 已实现 |
| PORT-P08 | 受保护管理员初始化 | 启动时读 `BOOTSTRAP_ADMIN_EMAIL/PASSWORD`，或 `POST /api/auth/setup`；DB 触发器保护 | 已实现 |
| 修改密码 | 登录后自查改密并强制重新登录 | `POST /api/auth/change-password`、`AppShell` 员工菜单 | 已实现 |
| RBAC | 六角色 × 8 菜单权限矩阵 | `server/src/backoffice/modules/rbac/permissions.ts`（前端同名副本只管显示） | 已实现 |
| 接口守卫 | 所有 `/api/**` 按登录与菜单权限放行 | `server/src/backoffice/nest/{route-access.ts,backoffice-access.guard.ts}` | 已实现 |
| i18n | en-GB / zh-CN 切换 | `client/src/backoffice/messages/*.json`、路由前缀 `/:locale/...` | 已实现 |
| PORT-NAV-006 | 语言偏好跨登录保留 | `lgbo_locale` Cookie + `employee_ui_preferences`、`POST /api/preferences/locale` | 已实现 |
| PORT-NAV-003 | 侧栏折叠状态跨登录保留 | `POST /api/preferences/sidebar` + `/api/session` 返回 `sidebarState` → `AppShell.initialCollapsed` | 已实现 |
| PORT-ACT-003 | 过期 / 已使用链接区分 | `classifyTokenState` + `TOKEN_EXPIRED` / `TOKEN_ALREADY_USED` | 已实现 |
| 邮件投递 | SMTP（163）→ SESv2 → DEV console 三级适配，参数与 LearningGuidePortal 一致 | `server/src/backoffice/modules/notification/services/email.ts` | 已实现 |

Course 菜单目前只有落地页占位，等 Course 的 PRD 和 Figma 到位后再做。

## 2. 技术栈（并入 Admin 后）

- 服务端：NestJS（`server/`），BackOffice 业务放在 `server/src/backoffice/`，沿用原有分层：controller → services → repositories（`pg` 原生 SQL）
- 表结构：Prisma Migrate（`server/prisma/migrations/20261023150000_backoffice_employees`），`schema.prisma` 同步声明模型
- 前端：Vite + React 19（`client/`），`react-router-dom` 管路由；BackOffice 页面在 `client/src/backoffice/`，KS / AI Tutor 页面放进同一个外壳
- 密码哈希：`node:crypto` scrypt（每账号独立盐），无外部依赖
- 令牌：随机 32 字节，落库只存 HMAC-SHA256；HMAC 密钥取 `SESSION_SECRET`，未配置时首次启动生成并存入 `backoffice_settings`

### 2.1 接口权限（服务端唯一权威）

| 路径 | 要求 |
|---|---|
| `/api/health`、`/api/auth/{email-check,sign-in,sign-out,activate,forgot-password,reset-password,setup}` | 公开 |
| `/api/user/**`（Portal 学员端调用） | 服务密钥 `X-API-Key`（原 `ApiKeyGuard`，不变） |
| `/api/session`、`/api/preferences/**`、`/api/auth/change-password` | 已登录 |
| `/api/ai/**` | AI Tutor 菜单可见 |
| `/api/courses`、`/api/pages`、`/api/releases`、`/api/sync`、`/api/files`、`/api/tags` | Knowledge 菜单可见（课程列表与发布读取 AI Tutor 也可用） |
| `/api/admin/**` 及任何未登记的接口 | 仅 Admin |

## 3. 分层与边界

```
Controller → 输入校验 → 守卫（会话/权限） → modules/*/services → repositories → PostgreSQL
```

硬约束：

1. Controller **不写业务规则、不写 SQL**，只做解析/校验/取会话/调 service/返回信封
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
- 写请求 CSRF：会话 Cookie 为 SameSite=Lax，SPA 与接口同源（同一 Nest 服务），跨站写请求会被 Cookie 策略阻断
- 员工账号相关 API 统一走全局 `BackofficeAccessGuard`（`nest/backoffice-access.guard.ts` + `nest/route-access.ts`）：无会话 401、非 Admin 403

## 5.1 邮件投递

`server/src/backoffice/modules/notification/services/email.ts` 与 LearningGuidePortal `services/emailService.ts` 保持相同的取值约定：

| 优先级 | 触发条件 | 行为 |
|---|---|---|
| 1 | `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` | nodemailer SMTP 投递（线上 163：`smtp.163.com:465`） |
| 2 | 仅 `SES_FROM_EMAIL` | AWS SESv2（默认 `ap-southeast-1`，实例角色授权） |
| 3 | 都没有 | DEV 打到服务端日志；其它环境返回 `NOT_CONFIGURED` |

发件人按 `SMTP_FROM` → `SES_FROM_EMAIL` → `SMTP_USER` 回退。投递异常返回 `FAILED`。
接口把真实投递结果（`SENT` / `FAILED` / `NOT_CONFIGURED`）回显到列表页，
不再出现「已加入发送队列」这类不实提示（PORT-ADM-002）；非 PROD 且未投递时额外返回 `manualLink` 供 Admin 手工转交。

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
| 认证页背景 | `/portal/auth-library.jpg` | 已复制到 `client/public/portal/auth-library.jpg` |
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
| 邮件投递只有 console adapter | 部署环境返回 `NOT_CONFIGURED`，不会伪装成功；非 PROD 时页面显示链接供手动转交 | 部署环境配置 `SMTP_*`（163）后即可真实发信 |
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

## 6.2 部署配置（Admin DEV / SIT / PROD）

| 变量 | 必填 | 说明 |
|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | 首次部署建议 | 库里还没有员工时，启动自动创建受保护管理员；已有员工时忽略 |
| `AUTH_TOKEN` | 建议 | 同时用于 `/api/user/**` 服务密钥和 `POST /api/auth/setup`（网页创建首个管理员）的校验；PROD 未配置时 setup 一律拒绝 |
| `SESSION_SECRET` | 可选 | ≥32 字符；不配则首次启动生成并存库，多实例共用 |
| `BACKOFFICE_APP_URL` | 可选 | 邮件链接的站点地址；不配则取请求来源（仅 localhost 与 `admin*.ilovelearningguide.com`），兜底 `https://admin.ilovelearningguide.com` |
| `APP_ENV` | 已有 | 非 PROD 且邮件未发出时，接口把激活/重置链接返回给 Admin，页面显示供手动转交 |

注意：开启后所有 KS / AI Tutor 页面和接口都需要登录。

默认管理员（2026-10-23）：迁移 `20261023170000_backoffice_default_admin` 在库里还没有任何员工时，建受保护管理员 `admin@ilovelearningguide.com`。仓库只存 scrypt 哈希，初始密码另行交付；仓库公开，首次登录后须立即改密码。已有员工的库不受影响；`BOOTSTRAP_ADMIN_*` 与 `/api/auth/setup` 仍可用于其他环境。

## 7. 验收方式

```bash
cd server && npx prisma generate && npm run build && npm test && npm run test:e2e
cd client && npx tsc -p tsconfig.app.json --noEmit && npm run lint && npm run build
```

自动化测试：

| 文件 | 覆盖 |
|---|---|
| `server/src/backoffice/tests/*.spec.ts` | 原独立应用的单元测试（权限矩阵、令牌五态、密码、限流、信封、员工派生状态）+ 接口路径权限表 `route-access.spec.ts` |
| `server/test/backoffice.e2e-spec.ts` | 未登录 401、健康检查公开、`/api/user` 仍走服务密钥、六角色 × KS/AI/员工接口权限、员工全生命周期（创建→重复 409→未激活 403→激活→重复使用 410→登录→停用即吊销会话）、语言偏好、改密吊销会话、setup 在已有员工时拒绝、受保护管理员不可降级 |
| `server/test/{ai,files,knowledge,tags}.e2e-spec.ts` | KS 原有 E2E，改为以 Admin 身份登录后调用 |

人工验收：

1. 无会话访问 `/en-GB/course` → 跳转 sign-in
2. 非 Admin 直接输入 `/en-GB/settings/employee-account` → 无权提示
3. 非 Admin 直接输入 `/zh-CN/knowledge`（如 Operation Admin）→ 无权提示
4. 停用某员工后其已有会话立即失效
5. 点专用激活链接过期/已用 → 看到不同提示文案
6. 切到中文后退出再登录 → 仍为中文
