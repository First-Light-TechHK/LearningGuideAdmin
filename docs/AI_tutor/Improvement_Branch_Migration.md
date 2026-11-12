# AI_Tutor_改进版分支迁移记录

## 范围与基线（2026-11-09）

当前分支基线 `af89717`。`dev` 的 `e05ba4f` 含 AI Tutor 母版适配及全仓 lint 清理，也修改了其他 Backoffice 模块；`d5ba38c` 与 `1a2f568` 含后续图片、模型改进。按调用链逐项接入，不整笔合并提交。`AITutor-main` 仅供行为参考，不修改。

保留 Backoffice 契约：后台测试使用 `aiTestReleaseId ?? currentReleaseId`，学员只使用 Online 课程的 `currentReleaseId`；Group Study 使用 Lecture。MAIN、Lecture、Socratic、Assessment 四套提示词的 Save / Reset 和覆盖顺序不变，实际 Assessment 评分单独实现。

## 实施顺序

1. 迁入配置快照、上下文、Prompt 编译、Provider 流式与错误处理；保留大 Release 检索和专项来源规则，新增离线回归。
2. 迁入前端按员工／课程／Release 的历史、逐块输出、取消和 Markdown／KaTeX；沿用现有 ShellRoute 与权限 Context，避免全局组件导出迁移。
3. 接入后续图片与模型改进，逐项检查其对 KS、Portal、Release 与安全边界的依赖。
4. 依次验证 lint、类型、相关单测和 build；全仓既有 lint 债务单列处理。数据库 e2e、真实模型与 UI 按环境另验，UI 不由开发智能体启动浏览器。
5. 母版其余能力按持久学习状态、Planner、实际 Assessment 评分、确定性展品和多路线试跑分别实现，完成独立 Review。

## 状态

2026-11-09：已按文件迁入 `e05ba4f` 的核心 Tutor 链，以及 `d5ba38c`／`1a2f568` 的图片与模型改进。新组件沿用本分支的 `ShellRoute`、`workspaceAccess` 导出；补齐 Embedding 错误的英文译文。用户此前确认的 app/vendor 分包规则也已恢复。`AITutor-main` 和 `rollback/` 均未修改。

验证：迁移目标文件的后端 ESLint、前端 oxlint、两端 TypeScript 均通过；后端 build 和前端 build 通过，前端最大 JS 约 293 kB，无体积警告。全套后端测试 1805 passed / 166 skipped；全套前端测试 500 passed。测试中的上游连接／磁盘故障日志来自异常分支用例。`git diff --check` 通过。

全仓门禁未通过：后端只读 ESLint 仍有 661 errors（本轮迁移目标文件定向检查为 0）；前端 oxlint 有 60 warnings，位于未迁移的旧组件和页面。`e05ba4f` 的全仓清理混有其他 Backoffice 工作，未整笔移入。应单独审查并处理，不将此处记录为全仓 lint 通过。

下一阶段：按已确认的 Portal／KS 分工，先交付 Release 绑定契约，再分别实现学习状态、Planner、Assessment 评分与多路线试跑，并逐项加离线回归。独立 Review、数据库 e2e、UI 与真实模型验收尚未进行。

## Portal / KS 数据边界（2026-11-09 确认）

Portal 管学员身份、课程权限、对话和学员学习状态；KS 管知识库／课程 Release、Prompt、AI Tutor 教学计算及客服后台。先前建议在 KS 新增 `TutorLearningState` 表不再作为当前实施方案。现有 `AiChatSession` 仍只用于后台调试，KS 不以请求体中的可选 `userId` 建立学员持久记录；Group Study 不混入个人学习状态。

本轮仅为 Portal 后续接入准备兼容契约：`GET /api/user/ai-tutors` 每项新增 `currentReleaseId`；`POST /api/user/ai/chat-stream` 可选 `expectedReleaseId`，若当前上线版本不同则在生成前返回 409。Portal 目前未消费新字段，因此跨版本会话隔离尚未端到端生效。Portal 侧需要在登录和课程授权后，以自身存储按学员／课程／Release 隔离状态，并从服务端请求传入预期版本。KS 的模型结果若要更新 Portal 状态，须另定义版本化、可校验的结构化结果；仅完成的成功轮次可写入，失败、取消与 `unscored` 不推进学习进度。

本轮验证：相关后端 ESLint、前端 oxlint、两端 TypeScript 通过；后端 `ai-config.service.spec.ts` 与 `ai-chat.service.spec.ts` 共 103 passed，前端 `i18n-guard.test.ts` 9 passed；两端 build 通过。新字段尚未由 Portal 使用，未做端到端验收。

本地和云端共用相同代码，KS 地址、服务凭据与超时由各环境配置提供；不得将 localhost、密钥或云地址写进教学逻辑。当前 API Key 只认证服务调用方，不能单独证明学员身份。Portal 侧的改动范围待单独确认；本轮不修改 Portal、数据库 schema、环境变量或部署配置。

## 后端质量排查（2026-11-09）

全仓只读 ESLint 共 661 errors，其中 `src/ai` 为 9 errors，集中在 Helpdesk 的两个测试文件与 Release 回答器。曾短暂迁入 `dev` 中这 3 个文件的 lint 修正，并通过定向验证；用户指出 Helpdesk 不属于本轮 AI Tutor／KS 范围后，已撤回这 3 个文件的改动。全仓 lint 债务仍在，不宣称门禁通过。

范围收窄：AI Tutor 图片 Controller 只在组装方提供图片文件模块时挂载。未提供文件模块的其他 Agent 组装不应因缺 `TUTOR_IMAGE_SOURCE` 而失败；正式 AppModule 仍提供文件模块，学员图片接口保持启用。Helpdesk 源码和测试均回到原分支状态。

## 基础能力验收（2026-11-09）

改动范围按职责归组：`server/src/ai/` 的 Chat、Config、Provider、Prompt、Tutor 上下文、Embedding 和图片接口及其测试；`client/src/api/ai.ts`、`client/src/components/ai/`、`client/src/pages/AITutor.tsx`、`client/src/stores/aiStore.ts` 与 AI Tutor 测试；KS 装配 `server/src/ks/ks.module.ts`、图片契约 `server/src/contracts/tutor-image.ts`、必要的 `server/src/app.module.ts` 与 `server/src/files/files.module.ts`；Tutor 错误译文、分包配置及本目录设计记录。`rollback/` 是原有未跟踪备份，未修改；Portal 与 Helpdesk 均不在改动范围。

当前分支仍为 `AI_Tutor_改进版`，Helpdesk 目录无工作区改动。已核对后台测试读取 `aiTestReleaseId ?? currentReleaseId`、学员读取 Online 的 `currentReleaseId`、四套 Prompt 配置、逐块 SSE、取消/失败终态、上下文检索与上线图片权限的实现和回归。后端 AI Tutor/KS 相关文件定向 ESLint 通过（`ks/prisma-knowledge.client.ts` 原有 Agent 导入禁令另列）；前端相关 oxlint 通过；后端 `tsc --noEmit -p tsconfig.build.json`、两端 build 通过；全套 server 单测 1806 passed / 166 skipped、全套 client 单测 500 passed。`git diff --check` 通过。

这些是离线测试与构建结果。数据库 e2e 被跳过，尚无真实 HTTP/SSE、真实模型、UI 验证；因此仅证明当前代码通过离线门禁，不能宣称线上或本地活体已验收。全仓 ESLint 仍有非本轮范围的既有债务。独立 Review Agent 对 AI Tutor／KS 本次迁移给出 APPROVE、无 Blocking；复核确认 Portal 现有学员图片渲染会转向已鉴权的同源代理，Portal 文件未修改。
