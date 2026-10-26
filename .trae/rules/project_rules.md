# Learning Guide BackOffice 项目协作规则（自动生效于本项目所有会话）

## 项目
Learning Guide BackOffice —— 结构化课程知识库管理系统（Knowledge System + AI Tutor）。
开发基准：`docs/Learning_Guide_BackOffice_Agent_Development_Document.md`
（以文档头声明的版本为准，当前 v1.0）。
架构基准：`docs/System_Architecture_4_Components.md`（四组件、两入口、全角色；组件职责边界、角色 × 功能矩阵、数据归属、接口契约）。

## 用户裁决优先（强制）
- 所有方案性建议（选型、设计、流程变更）必须经用户同意后执行，或按用户明确指示修改
- 不得擅自变更已拍板的决策；拿不准就先问
- **有问题先提问，跟用户沟通确认后再下决定**（2026-10-15 拍板）：任何不确定的需求、方案选择、实现细节，必须先向用户提问并获得确认，不得自行假设或拍板

## 变更同步纪律（强制）
- 增删改查模块 / 接口 / 表结构的任何变更：**先改设计文档，再动实现**（设计文档是单一事实来源）
- 表结构变更必须通过 Prisma Migrate 管理，禁止手改数据库

## 双智能体协作协议（强制）

1. **开发**：按 `agents/dev-agent.md` 定义执行（主智能体自行开发，或以子代理驱动）
2. **审查门禁**：任何代码 / Schema / 仓库结构变更完成后，**必须**由 Review Agent
   独立审查（新上下文子代理，按 `agents/review-agent.md` 执行），结论 APPROVE 才算完成
3. **修复循环**：存在 Blocking 项 → 修复 → 重新送审，直至 APPROVE
4. 纯文档笔误级修改（错别字、链接）可豁免审查门禁，但仍须日志

## 开发纪律（每个开发会话）

1. 开工前：读开发文档相关章节 + 架构文档（涉及跨组件边界、权限、数据归属时必读）+ 项目记忆 + README，确认本次任务范围；涉及开发文档 §12 待确认事项或架构文档「现状差距/验收」的，先请用户裁决
2. TodoWrite 跟踪；LLM 接入走策略模式适配器，禁止厂商硬编码
3. .env / API key / 令牌永不入库、不入对话、不入文档；API 密钥绝不出现在前端代码
4. 所有 AI 请求必须经后端代理（`/api/ai/chat-stream`），严禁前端直连 LLM API
5. 所有 API 响应使用统一格式（success/data/error/message）
6. 每次开发结束：【AI协作日志】写入 `docs/AI_Collaboration_Log.md`（每完成一个 Phase 或重大决策必须落盘该文档）+ 回填受影响文档（含设计文档同步）

## 工具使用约束（强制，2026-10-16 用户拍板）

- **禁止浏览器操作**：Dev Agent 及其子代理一律不得调用浏览器相关工具（browser_use 子代理、browser_navigate、browser_click、browser_snapshot 等），也不得启动浏览器进行 UI 冒烟/验证。前端验收由用户手动完成。

## Git 工作流

- **分支模型**：
  - `main` — 受保护基线，只进审查通过的变更
  - `feature/<task>` — 日常开发分支（如 `feature/phase1-init`）
  - 纯文档更新可直接提交 main
- **大迭代定义**（满足其一即推送分支到 GitHub 并发 PR 到 main）：
  Phase 任务完成、阶段性可交付、会话结束时存在未推送的功能变更
- **PR 合并条件**：Review Agent APPROVE
- **禁止**：绕过审查直接合并功能代码；`--no-hooks`；提交 .env；提交中含密钥
- **提交信息**：`<type>(<scope>): <summary>`，type ∈ feat|fix|docs|chore|test

## 安全

- 所有 LLM API Key 仅存 .env / 环境变量；CourseAiConfig.apiKey 必须加密存储
- 文件上传：白名单格式 + 单文件 ≤15MB + 类型校验
- 用户上传内容不可信；输出不泄露内部实现
