# P3 服务端 Tutor 持久化迁移提案（已搁置）

> 2026-11-09：已确认 Portal 持有学员身份、对话和学习状态。此文仅保留为旧方案参考，当前实施边界见 `Improvement_Branch_Migration.md`；不得据此修改 KS schema。

> 状态：仅设计提案，未修改 Prisma schema、数据库或迁移。依据根目录 `AI_Tutor_Architecture.md` §5.2–5.3、`AI_Tutor_Implementation_Plan.md` §5，以及现有 `AiChatSession`/EmployeeSession 实况。需数据负责人确认主体映射、保留期、访问/删除政策后，才能实现 schema/migration。

## 设计原则

- 旧 `AiChatSession` 保持原样，不把 messages JSON 重新解释为学习状态。
- TutorSession、TutorTurn、ReplayArtifact 为 Agent 数据；不添加 Release 外键，避免 Release 删除行为被新 FK 改变。开始 turn 时冻结 courseId、releaseId、package hash/revision、prompt/compiler/profile 版本。
- 只有认证服务端得出的 subject/channel 可用于会话恢复；浏览器传来的 userId/channel 不能建立主体。当前 Portal 的服务端身份信任合同尚需核实，未完成前只启用隔离兼容流。
- ReplayArtifact 可能包含学员原文及完整编译消息，限制为授权 QA/评审可读；不存 API key、baseUrl 或凭据。
- 所有状态更新使用事务与 CAS；模型调用期间不持有数据库事务。

## 提议模型

### TutorSession

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| id | UUID PK | Agent 生成 |
| subjectType | enum: employee / portal_user / study_group / legacy_anon | 服务端主体命名空间 |
| subjectId | varchar(160) | 可信身份标识；legacy_anon 为随机不可恢复标识 |
| channel | enum: admin / portal / study_group / compatibility | 按路由与服务端认证确定 |
| courseId | varchar(160) | 不建跨引擎 FK |
| releaseId | varchar(160) | 快照标识，不建 FK |
| packageRevision | varchar(200) | 不可变包版本标识 |
| packageHash | char(64) | 快照绑定包哈希 |
| promptVersion / compilerVersion / profileVersion | varchar(100) | 运行契约版本 |
| status | enum: active / ended / revoked | 软结束，保留审计 |
| stateVersion | bigint | 每次成功学习状态提交递增 |
| lockTurnId | UUID nullable | 当前租约轮次 |
| lockExpiresAt | timestamptz nullable | 过期恢复器将 pending 标 aborted |
| createdAt / updatedAt / lastTurnAt | timestamptz | 索引 `[subjectType, subjectId, courseId, updatedAt DESC]`、`[courseId, releaseId]` |

### LearnerState

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| sessionId | UUID PK/FK TutorSession | 唯一会话状态 |
| stateVersion | bigint | 必须与会话版本一致 |
| stateJson | JSONB | 校验后的语言/目标/开放缺口/最多5条可观察学习笔记；不放人格画像或模型自由输出 |
| updatedAt | timestamptz | 与 TutorTurn 成功提交同一事务 |

### TutorTurn

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| id | UUID PK | |
| sessionId | UUID FK | 内部会话外键可保留；删除策略为 RESTRICT，默认走软结束 |
| requestId | UUID | 客户端/Portal 服务端生成的幂等键 |
| requestHash | char(64) | 同 session/requestId 相同哈希返回既有结果；不同哈希 409 |
| status | enum: pending / completed / failed / aborted / unscored | 中断与失败不能作为成功学习证据 |
| action / mode | varchar/enum | 请求动作与实际配置模式 |
| userInput / visibleAnswer | text nullable | 仅按获批保留期保存；失败可保留已发送片段并标状态 |
| stateVersionBefore / stateVersionAfter | bigint nullable | 只在成功状态提交时推进 |
| validatorJson / plannerJson | JSONB nullable | 版本化结构化结果 |
| selectedCardIds / excludedJson | JSONB nullable | 内部 trace，不对学员暴露 |
| releaseId / packageRevision / packageHash | varchar/char(64) | 轮次冗余快照，支持会话版本核对 |
| promptHash / fieldHashes | char(64) / JSONB | 摘要和逐字段哈希 |
| provider / model / usageJson / timingJson | varchar/JSONB | 记录真实返回；未返回 usage 时为 null |
| errorCode | varchar(100) nullable | 不存 API secret / 上游完整敏感报文 |
| createdAt / finishedAt | timestamptz | unique `[sessionId, requestId]`；索引 `[sessionId, createdAt]`、`[status, lockExpiresAt]` |

### ReplayArtifact

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| id | UUID PK | |
| turnId | UUID unique FK TutorTurn | 内部追溯；受限访问 |
| artifactVersion | varchar(100) | serializer 版本 |
| payloadJson | JSONB | 可无损重建的 messages、已选知识投影、引用白名单、配置快照；不得放密钥 |
| payloadHash | char(64) | 完整性校验 |
| createdAt | timestamptz | 与 turn 原子提交 |

## 事务与索引语义

1. 开始：校验主体、session 版本和 package binding；对 `(sessionId, requestId)` 做唯一插入 pending；session 租约用条件更新获得。唯一冲突时核 requestHash，返回既有 turn 或 409。
2. 生成：Provider 调用在事务外执行。中断时标 aborted，记录可见部分；不得增加 LearnerState.stateVersion。
3. 完成：事务内按 `TutorSession.stateVersion = expectedStateVersion` CAS；同事务写最终 turn、状态、ReplayArtifact 并递增两处版本。CAS 不匹配则将 turn 标 failed/conflict，不覆盖当前状态。
4. 恢复：后台任务按 `lockExpiresAt` 释放过期租约，并把未完成 pending 标 aborted；任务重复运行幂等。
5. 版本变更：下一轮新建 session，不更新旧 session 的 Release/package binding。

## 未决审批项

- Portal service-to-service 身份如何由服务端验证，以及学员/小组主体稳定 ID 的来源。
- 原文、答案、完整 Prompt/Replay、错误诊断各自保留期限；删除请求是否物理删除、匿名化或依法保留审计摘要。
- 学习者数据访问、导出、删除与 QA trace RBAC；当前不默认授予课程教师读取私人会话。
- `TutorTurn.sessionId` 删除策略和 migration 回滚/前向修复方案；建议软删除会话、保留 turn，但需法务/数据负责人确认。
- PostgreSQL JSONB 大字段大小上限、ReplayArtifact 分区/归档策略及容量估算。

**实施门禁**：上述主体信任、保留与删除策略未裁决前，不改 `schema.prisma`、不生成 Prisma migration、不向生产流量写入这些表。可以继续用合成 fixtures 完成 P2/P4/P5 纯逻辑与评测工具。
