# Sandbox 账号边界与账号级功能权限

> Owner 2026-11-20 决策：BackOffice 账号管理新增「功能权限」栏——角色给基线、账号级开关可加可减；Sandbox 后台只对后台员工账号开放，学习用户/学员永不进入。Owner 2026-11-24 修订：Sandbox 不再做能力分区，**全模块、全角色**（不设置 `ADMIN_CAPABILITIES` / `APP_ROLES`）。
> 本文件是权限契约与决策记录，**不实施代码、不改变课程业务语义**。配套：`docs/sandbox/partitioning.md`（逻辑分区）、`docs/BackOffice_Portal_Implementation.md` §3.3（账号管理仅 Admin）。

## 0. 结论（TL;DR）

| # | 结论 |
|---|---|
| 1 | Sandbox 后台 = BackOffice 员工账号体系；学员/学习用户账号与后台账号完全分离，永不进入 Sandbox 后台。 |
| 2 | 默认单管理员（bootstrap 轮换）；需要多人时由 Admin 在 Employee Account 建号。系统支持多员工、多会话并发，无席位限制。 |
| 3 | 账号级功能开关：生效权限 = 环境能力 ∩（角色基线 ± 账号开关）；**环境能力永远优先、一票否决**。 |
| 4 | Sandbox 环境能力：**不设置 `ADMIN_CAPABILITIES` = 全部能力**；`accounts` 与其它 Settings 均可用。 |
| 5 | 发布/导出按角色矩阵（ADMIN 与 OPERATION_ADMIN 的 course=FULL；其余默认无），可按账号单独开通 `course.publish` / `course.export`；导入用 `course.import`；新建/删除只按角色矩阵（不开放账号级开关）。 |
| 6 | 最后管理员保护、停用即吊销会话、feature 变更审计、预览令牌 10 分钟且只读。 |

## 1. 账号边界：Sandbox 只允许 BackOffice 员工账号

- Sandbox 后台唯一入口 `admin.sandbox.ilovelearningguide.com`，只认 Admin 库 `employees` 表 + 员工会话（`employee_sessions`）。一个后台账号 = 一行 `employees`（六角色之一、ACTIVE/INACTIVE、邮箱验证）。
- 学员/学习用户属于 Portal（`sandbox.ilovelearningguide.com`），账号与会话都在 Portal 自己的库和登录体系（Google / WeChat / 邮箱）；与 `employees` **无映射、不同步、不共用 Cookie**（两边会话 Cookie 均为 host-only，见 `docs/sandbox/partitioning.md` §1）。
- Admin 的 `/api/user/**` 是 Portal → Agent 的**服务间接口**：只认 `X-API-Key`（`AUTH_ENABLED=true` + `AUTH_TOKEN`），不走员工会话，也不是用户登录入口。Sandbox 不设 `APP_ROLES` = 全角色，agent 已挂载，但仍是服务间接口；`/api/ks/**` 同样只认 `KS_SERVICE_TOKEN`（未配置时回退 `AUTH_TOKEN`）。
- BackOffice 登录只接受 `employees` 中 **Active + Verified** 的账号（BR-PORT-005）；没有学员自助注册 / OAuth 进入后台的路径。

**部署事实（Sandbox）**

| 变量 | 值 | 作用 |
|---|---|---|
| `APP_ROLES` | 不设置 | 全角色（admin/agent/ks）启动；学员端/KS 仍只走服务密钥 |
| `AUTH_ENABLED` | `true` | 服务间接口强制 `X-API-Key` |
| `AUTH_TOKEN` | ← `learning-guide/admin/sandbox/admin_api_key` | Portal→Admin 服务密钥（部署映射，文档不写值） |

**硬规则**

1. 禁止把学员/学习用户账号或邮箱加入 `employees`；`employees.role` 只能取六种后台角色。
2. 员工激活链接只发给 Admin 建号时录入的员工邮箱，不得转发给学员。
3. 任何「批量导入账号」脚本不得以 Portal 学员表为数据源。

| 身份类型 | 账号存放 | 认证方式 | 能否进 Sandbox 后台 |
|---|---|---|---|
| BackOffice 员工 | Admin 库 `employees` | 邮箱 + 密码，员工会话 Cookie | 能（仅被授予账号/角色者） |
| Portal 学员/学习用户 | Portal 库 | Portal 自有登录（Google/WeChat/邮箱） | **不能** |
| Portal → Admin 服务调用 | 无账号，持服务密钥 | `X-API-Key` / Bearer | 不是后台登录，不产生后台会话 |

## 2. 多用户策略：默认单管理员，多人 = Admin 建号 + 账号级功能开关

**现状判断（回答 Owner 问题）**

- Sandbox **部署默认只有一个 bootstrap 管理员**（`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`），首期按单人运维配置——这是**部署默认**，不是代码限制。
- 系统本身支持多员工账号与多会话并发：`employees` 多行、同一员工可多会话、无席位上限；是否多人使用由 Admin 开号控制，不由部署形态限制。
- bootstrap 轮换：迁移占位管理员 `admin@ilovelearningguide.com` 在「库里只有它且未被动过」时，首次启动一次性轮换为 env 管理员（保留 ADMIN/ACTIVE/VERIFIED/`is_bootstrap_admin`）；已有真实员工则跳过、绝不覆盖（QA 3.1.1，审计 `bootstrap_admin_rotated`）。

**多人使用流程**

1. Admin → Settings › Employee Account → 新建账号：录入员工邮箱、选角色、设状态。
2. 员工邮箱收激活链接（48 小时有效）→ 设密码 → 登录；仅 Active + Verified 可登录。
3. 调整权限：改角色（角色基线），或在「功能权限」栏按账号加减功能键。
4. 离职/停用：状态改 INACTIVE → **立即吊销全部会话**（BR-PORT-013）。

**账号级功能开关（本次新增）**

- 每个账号在角色基线之上有功能开关，三态：**继承**（默认，随角色）/ **允许** / **禁止**。
- 生效规则：

```text
生效(menu, action) =
    环境能力已启用(menu)                 // 外门：一票否决，账号开关不能穿越
  AND ( 账号禁止该功能 ? false
        : 角色基线允许 OR 账号允许该功能 )
```

- 环境能力永远优先：`ADMIN_CAPABILITIES` 未启用的模块，账号开关不能打开——菜单隐藏、API 404 `MODULE_NOT_ENABLED`。
- 例外（硬规则）：Employee Account 管理（`/api/admin/employees/**`）只认 **ADMIN 角色**（§3.3），账号开关不可越级授予。
- UI 形态：Employee Account 编辑弹窗内的「功能权限」区，逐项三态开关（继承/允许/禁止）；始终以服务端 `effective` 徽标为准，INHERIT 行同时显示只读角色基线（模块级别或动作允许/禁止）；仅 ADMIN 可见；保存即审计。

| 层级 | 决定者 | 示例 | 优先级 |
|---|---|---|---|
| 环境能力 `ADMIN_CAPABILITIES` | 部署配置 | Sandbox 不设置 = 全部能力 | **最高（一票否决）** |
| 角色基线 `ROLE_MATRIX` | 账号角色（六选一） | `COURSE_CREATOR` → course = VIEW | 中 |
| 账号级功能开关 | Admin 在账号管理里配置 | 给某 `GRAPHIC_DESIGNER` 开 `course.publish` | 最低（可加可减，不能穿越环境能力） |

## 3. 角色映射建议（做课团队）

| 用途 | 建议角色 | 角色基线（现状 `ROLE_MATRIX`） | 账号级开通建议 |
|---|---|---|---|
| 做课内容查看（只读） | `COURSE_CREATOR` | 全部菜单 VIEW（course 只读） | 无；默认即只读 |
| 内容/图形编辑（改既有课程） | `GRAPHIC_DESIGNER` | course = EDIT（只能改既有内容；不能新建/删除/发布） | 需要导入草稿时开 `course.import` |
| 发布 / 导出 | 默认仅 `ADMIN` | course = FULL | 按账号单独开通 `course.publish` / `course.export` |
| 账号管理 | `ADMIN` | Employee Account FULL | 不授予非 ADMIN |

**Course 模块功能键（账号级词表，已实现）**

| 功能键 | 语义 | 动作判定（路由映射） | 默认 |
|---|---|---|---|
| `course.view` | 查看课程/版本/预览 | VIEW | 有 Course 菜单的角色 |
| `course.edit` | 修改既有课程内容（含媒体） | EDIT_EXISTING | `GRAPHIC_DESIGNER`、`ADMIN` |
| `course.import` | 导入课程包（整包新建或覆盖）与导入作业状态 | IMPORT | 仅 `ADMIN`；按账号开通 |
| `course.export` | 导出课程包、导出作业状态与下载 | EXPORT | 仅 `ADMIN`；按账号开通 |
| `course.publish` | 发布/上下线/恢复/删除草稿 | PUBLISH | 仅 `ADMIN`；按账号开通 |
| `course.create` / `course.delete`（已移除） | 新建课程 / 删除课程 | CREATE / DELETE | **仅角色矩阵**（FULL 角色）；2026-11-20 F3 收口：不再作为账号级开关，存量 grant 行读取时忽略 |

> 说明（2026-11-20 已落地，2026-11-24 修订）：`backofficeCourseAction` 把 import/export/publish 拆成独立动作；**GET 作业状态与下载同样受 IMPORT/EXPORT 约束**（不能凭 VIEW 下载导出包）。账号级开关在角色基线上可加可减，环境能力始终优先（Sandbox 环境能力全开；如部署显式裁剪，则被裁模块一律拒绝）。`course.create`/`course.delete` 已从账号级功能目录移除：新建/删除只由角色矩阵控制，存量 grant 行按未知 key 忽略（幂等），PUT 拒绝写入这两个 key。

## 4. 环境能力：Sandbox 全开（不设置 `ADMIN_CAPABILITIES`）

**决策（owner 2026-11-24）**：Sandbox Admin 不设置 `ADMIN_CAPABILITIES`。按 `server/src/common/capabilities.ts`，未设置 = 全部能力启用；因此 `course`、`accounts`、`settings`、`knowledge`、`ai`、`students`、`helpdesk`、`operations`、`reporting`、`order` 全部可用（仍按角色权限过滤菜单）。

- `course`：课程管理（列表/状态、导入与解析、预览、发布、版本与历史、导出）。
- `accounts`：**员工账号管理**——`/api/admin/employees/**` + Settings › Employee Account 页面/菜单。
- `settings`：学习权限（`/api/learning-access`）、支付、通知等 Settings 子项——已随全模块打开。
- 目标效果：Sandbox 里的 ADMIN 可自助建号/改角色/停用/发激活，并可使用全部模块；非 ADMIN 仍按角色矩阵与账号开关受限（§3.3）。
- **仍然不新增编辑能力**：全开只打开上游已有模块，不扩大课程编辑/新建/删除范围（新建/删除仍只由角色矩阵控制）。

| 能力 | 覆盖 | Sandbox | 说明 |
|---|---|---|---|
| `course` | 课程管理与导入导出、Portal 课程投影 | 开 | 现状 |
| `accounts` | 员工账号管理 `/api/admin/employees/**`、Employee Account 页 | 开 | 独立于 `settings` |
| `settings` | 学习权限 `/api/learning-access`、其它 Settings 子项 | 开（2026-11-24） | 全模块启用 |
| `knowledge` / `ai` / `students` / `helpdesk` / `operations` / `reporting` / `order` | 对应模块 | 开（2026-11-24） | 需密钥的功能按设计降级 |

**实现现状（2026-11-20，环境能力口径 2026-11-24 修订）**

- 能力表已有 `accounts`；`/api/admin/employees/**` 归 `accounts`，其余 `admin` 路由仍归 `settings`；capability-gate 单测/E2E 同时覆盖“显式裁剪”和“未配置 = 全开”两种语义。
- 账号级功能开关已实现：`employee_feature_grants` 表 + GET/PUT `/api/admin/employees/:id/features`，审计事件 `EMPLOYEE_FEATURES_CHANGED`（before/after）；`EMPLOYEE_FEATURES_CHANGED` 与既有 `employee_created` 等小写事件并存。
- 最后管理员保护：功能权限 API 内已禁止把最后一个可用 Admin 的 accounts 关闭/自我锁死；角色/状态降级路径也在同一事务 + advisory lock 内校验（含自我降级/停用），features 并发保存已串行化。
- Sandbox 模板与 provision 脚本均**不写** `ADMIN_CAPABILITIES`（全开）；`/api/admin/employees/**` 可用。

**开启 `accounts` 后的最小权限与审计要求**

1. 仅 ADMIN 角色可访问（`canAccessEmployeeAccount`）；账号级开关不得授予该能力。
2. 服务端是唯一执行点：`BackofficeAccessGuard`（employeeAdmin）+ 能力门；前端隐藏按钮不是安全边界。
3. 建号、改角色、停用、邮箱变更、发信全部写 `audit_events`（现有 `employee_created` / `employee_role_changed` / `employee_status_changed` / `employee_email_changed` / `password_reset_sent`）。
4. 审计写入是 best-effort、不阻断业务；需接入日志告警，审计写失败要能被发现。
5. 发信按操作者限速（`ADMIN_EMAIL_SEND_MAX_PER_WINDOW=20` / 5 分钟）。
6. 环境能力全开不改变 `accounts` 的服务端守卫：`/api/admin/employees/**` 仍只认 ADMIN 角色；如需在其它环境裁剪 `settings`，`accounts` 不会顺带打开它。
7. 账号管理 API 只走员工会话，不得暴露给 Portal/学员，也不走服务密钥。

## 5. 安全与审计

| 控制 | 规则 | 落点/证据 |
|---|---|---|
| 最后管理员保护 | `is_bootstrap_admin` 行不可删除/停用/降级/清标记（DB 触发器兜底），服务层返回 `PROTECTED_ADMIN_ACCOUNT`；功能权限 API 与角色/状态变更均在同一事务 + advisory lock 内校验「最后一个可用 Admin」，并发互降/并发关开关不会留下 0 个管理员 | `server/prisma/migrations/20261023150000_backoffice_employees` 的 `guard_bootstrap_admin`；`employeeAccount.ts`；`featureGrantRepository.ts`；`adminGuard.ts` |
| 停用即吊销会话 | 状态改 INACTIVE 时 `revokeAllForEmployee` 吊销全部会话；`resolveSession` 每次请求二次校验账号状态/验证状态，不满足立即吊销（BR-PORT-013） | `sessionRepository.ts`、`session.ts` |
| Feature 变更审计 | 新增事件 `EMPLOYEE_FEATURES_CHANGED`（action=UPDATE_EMPLOYEE；old/new 为功能键差异；actor/target/IP/requestId 沿用 `audit_events`）；角色变更/停用既有事件保留；不写密码/令牌（§11.3） | `auditRepository.ts`（已实现） |
| 预览令牌 | HMAC 签名，TTL **10 分钟**；只挂 GET（生成链接/内容/封面/媒体），不产生写操作；过期或篡改 401 `INVALID_PREVIEW_TOKEN`；预览页仍需员工会话，按角色/能力判定查看权限 | `portal-preview.service.ts`（`DEFAULT_TTL_SECONDS=600`） |
| 学员账号禁入 | `employees` 只由 Admin 建号，无自助注册/OAuth 绑定；角色限六种；运维/导入不得把 Portal 学员邮箱灌入 | 本文 §1；`employees` DDL |

## 6. 引用与决策记录

**引用**

| 主题 | 位置 |
|---|---|
| 账号管理仅 Admin、UI 与后端双重限制 | `docs/BackOffice_Portal_Implementation.md` §3.3 |
| 逻辑分区与 `ADMIN_CAPABILITIES` 能力门 | `docs/sandbox/partitioning.md` §5.1 |
| 角色权限矩阵（单一事实来源） | `server/src/backoffice/modules/rbac/permissions.ts` |
| 能力表与路由前缀映射 | `server/src/common/capabilities.ts` |
| 建号/改角色/停用/审计 | `server/src/backoffice/modules/employee-account/services/employeeAccount.ts` |
| 停用即吊销会话 | `server/src/backoffice/modules/user-authentication/services/session.ts` |
| 预览 token | `server/src/commerce-courses/portal-preview.service.ts` |
| bootstrap 轮换 | `verify-takeover-20261116/qa-3.1.1-bootstrap-admin-rotation-report.md` |

**决策记录**

| 编号 | 日期 | 决策 | 状态 |
|---|---|---|---|
| D-PERM-01 | 2026-11-20 | Sandbox 后台只对 BackOffice 员工账号开放；学员/学习用户永不进入 | 已实现（现有约束） |
| D-PERM-02 | 2026-11-20 | 默认单管理员（bootstrap 轮换）；多人由 Admin 在 Employee Account 建号 | 轮换已实现（QA 3.1.1）；沙箱默认单管理员 |
| D-PERM-03 | 2026-11-20 | 账号级功能开关：角色基线 ± 开关（可加可减），环境能力永远优先 | 已实现 |
| D-PERM-04 | 2026-11-20 | publish 级动作拆为 `course.import` / `course.export` / `course.publish` 三个账号级键，映射集中维护 | 已实现（含作业状态/下载） |
| D-PERM-05 | 2026-11-20 | Sandbox 能力集 `course,accounts`；`accounts` 独立于 `settings` | 已被 D-PERM-08 取代 |
| D-PERM-08 | 2026-11-24 | Sandbox 不再做能力分区：不设置 `ADMIN_CAPABILITIES`/`APP_ROLES` = 全模块、全角色；`accounts` 仍独立于 `settings`（显式裁剪时互不牵连） | 已实现（env 模板与 provision 脚本均已改为不写） |
| D-PERM-06 | 2026-11-20 | Employee Account 管理仅 ADMIN，账号级开关不可越级授予 | 已实现（§3.3） |
| D-PERM-07 | 2026-11-20 | F3：账号级功能目录移除 `course.create` / `course.delete`；新建/删除只由角色矩阵控制，存量 grant 行读取时忽略（幂等） | 已实现 |

## 待主控执行

- [x] **sandbox 分支 `deploy/sandbox.example.env`：不设置 `ADMIN_CAPABILITIES` / `APP_ROLES`（全模块、全角色）**；`scripts/provision-admin-dev.mjs` 的 sandbox 写入值已同步（只写环境标识与版本编号）。
- [x] 前置依赖：`accounts` 能力标识、`/api/admin/employees` 路由映射、客户端 `MENU_CAPABILITY` / Settings 子项 —— 已实现（本分支）。
- [x] 后续加固：角色/状态降级路径的最后管理员校验；features 写并发 TOCTOU —— 已改为同事务 + advisory lock。
