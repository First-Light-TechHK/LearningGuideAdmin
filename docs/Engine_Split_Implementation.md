# 引擎拆分实施说明（KS Engine / Agent Engine 可独立部署、独立扩容）

> 2026-10-24。总体设计见 Claude Doc「LG 系统设计：API · 引擎 · 数据层」，与 `docs/System_Architecture_4_Components.md` 的四组件划分一致。
> 本文只写这一轮落进代码的部分，以及还没做、留到下一步的部分。

## 1. 目标

- 同一个镜像，按角色起进程：`admin`、`agent`、`ks` 三个角色可以合在一个进程（今天的部署方式），也可以拆成三组实例分别扩容。
- Agent（AI Tutor）只通过契约读 KS 的数据，不再直接查 KS 的表；KS 改表、单独发版不影响 Agent。
- 一个系统挂了，另一个降级而不是崩：KS 不可达时 Agent 返回 `503 KS_UNAVAILABLE`。
- 限流在多实例下仍然准确。

## 2. 角色

| 角色 | 挂的接口 | 说明 |
|---|---|---|
| `admin` | BackOffice（`/api/auth/**`、`/api/backoffice/**`）、KS 编辑（courses / pages / releases / sync / tags / files）、AI 配置与后台测试对话（`/api/ai/**`） | 员工用 |
| `agent` | 学员对话 `/api/user/**`（Portal 调用） | 无状态，可横向扩 |
| `ks` | KS 内部接口 `/api/ks/v1/**` | 只给其他服务调，需要服务令牌 |

`/api/health` 每个角色都有。

## 3. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `APP_ROLES` | 空 = 三个角色全起 | 逗号分隔，如 `agent` 或 `admin,ks`；写错角色名启动直接失败 |
| `KS_BASE_URL` | 空 | Agent 所在进程没有 `ks` 角色时，经这个地址调 KS；空则直接读库（同库部署） |
| `KS_SERVICE_TOKEN` | 空 | KS 内部接口的 Bearer 令牌；部署环境下为空则内部接口一律 401 |
| `KS_TIMEOUT_MS` | 3000 | Agent 调 KS 的超时 |

不设任何新变量时行为与拆分前完全一样，现有 DEV 部署不需要改配置。

## 4. KS v1 内部接口（只做加法）

鉴权 `Authorization: Bearer <KS_SERVICE_TOKEN>`，返回统一信封 `{ success, data }`，找不到返回 404。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/ks/v1/courses?mapped=true` | 课程列表（mapped 只要已对应 Portal 课程的） |
| GET | `/api/ks/v1/courses/:id` | 单个课程 |
| GET | `/api/ks/v1/courses/by-external/:externalId` | 按 Portal slug 找课程 |
| GET | `/api/ks/v1/releases/:id/meta` | Release 元数据 |
| GET | `/api/ks/v1/releases/:id` | Release 页面快照 |
| PUT | `/api/ks/v1/courses/:id/tutor-test-release` | 设置后台测试用 Release（`{ releaseId }`） |
| PUT | `/api/ks/v1/courses/:id/tutor-online` | 设置 Tutor 上下线（`{ online }`） |

规则：新字段只能加、只能可选；调用方忽略不认识的字段（tolerant reader）。要改字段含义就开 `/v2`。

代码位置：

- 契约：`server/src/ks/contract/knowledge-client.ts`
- KS 侧实现（读库）：`server/src/ks/prisma-knowledge.client.ts`
- 内部接口：`server/src/ks/ks-internal.controller.ts`
- Agent 侧 HTTP 实现：`server/src/ai/knowledge/http-knowledge.client.ts`
- 选哪种实现：`server/src/app.module.ts` 的 `knowledgeProvider()`

## 5. 边界检查

`server/eslint.config.mjs` 用 `no-restricted-imports` 锁住模块边界：

- `src/ai/**` 不能 import KS 模块（courses / pages / releases / sync / tags / files）和 backoffice，只能用 `src/ks/contract`。
- KS 模块不能 import `ai`、`backoffice`。
- `src/backoffice/**` 不能 import `ai`、`ks` 和 KS 模块。

## 6. 限流改到数据库

原来的限流计数在进程内存里，起多个实例时每个实例各算各的，实际放行量是配额乘以实例数。现在改为表 `ai_rate_limit_hits`（迁移 `20261024090000_ai_rate_limit_hits`）：

- 同一个 key 在事务里先拿 `pg_advisory_xact_lock`，再删窗口外的行、计数、未超额才插入。
- 滑动 60 秒窗口；配额不变（学员个人对话 10 次/分钟，直播间 30 次/分钟可由 `AI_RATE_LIMIT_STUDY_GROUP_PER_MINUTE` 覆盖）。
- 被拒绝的请求不计数。

## 7. 测试

- 单测：`app-roles.spec.ts`、`service-token.spec.ts`、`http-knowledge.client.spec.ts`、`rate-limit.service.spec.ts`、`route-access.spec.ts`（新增 ks 类）。
- e2e：`test/engine-split.e2e-spec.ts` 真起两个进程（ks 一个、agent 一个）：
  - ks 内部接口无令牌 / 错令牌 401，正确令牌 200，不存在 404；ks 进程里没有员工和学员接口。
  - agent 经 HTTP 从 ks 读到课程；agent 进程里没有员工接口。
  - 3 个实例共用数据库限流，并发 15 次只放行 10 次，其余 429。
  - 停掉 ks 后 agent 返回 503 `KS_UNAVAILABLE`。

## 8. 还没做（下一步）

1. **拆库**：Tutor 自己的数据（`CourseAiConfig`、`AiChatSession`、`ai_rate_limit_hits`，以及暂存在 `Course` 上的 `aiTutorOnline` / `aiTestReleaseId`）迁到 Agent 自己的 schema。届时去掉 `CourseAiConfig.releaseId → Release` 的外键；目前删 Release 依赖这条外键级联删配置，所以要先由 KS 发「Release 已删除」事件、Agent 收到后清理，再去外键。这一步按 expand → migrate → contract 三次发版完成。
2. **分开部署**：DEV/SIT 用同一镜像起 `APP_ROLES=admin,ks` 和 `APP_ROLES=agent` 两组服务，Agent 配 `KS_BASE_URL` / `KS_SERVICE_TOKEN`。部署由运维决定，代码已就绪。
3. **Portal 侧**：Portal 调 Agent 改为按调用方发服务令牌并带作用域。
4. **检索**：KS 提供检索接口（替换目前把整份 Release 拼进上下文的做法），属于 KS 负责人的范围。
