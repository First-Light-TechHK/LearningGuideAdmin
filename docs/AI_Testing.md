# AI 测试实施契约

单题多轮、Excel 单轮和多轮批测、任务记录替代多线路测试。知识库始终开启，课程和 Release 必选。中英文界面、表头及回答语言独立；不自动评分。

批测全局并发 1；每任务最多 200 份回答，两种模式分别计数。固定模型、方案、语言、Prompt 和版本。每轮落库，任务按员工归属隔离。当前仅本地运行，执行器随后端启动，PostgreSQL会话锁保证跨实例串行，不修改云部署。

单轮列：题目编号/Case ID、问题/Question、备注/Notes。多轮列：会话编号/Conversation ID、轮次/Turn、问题/Question、备注/Notes。轮次从 1 连续，标识不重复；问题非空且最多 8000 字符。模板说明不参与题目解析。

停止：已成功结果保留；在途与未执行项失败，区分用户停止原因，片段标注不完整。停止后不重试、不续跑。重新开始复制原配置题目，新任务从空历史开始。停止与完成通过条件更新串行化；旧响应不能覆盖终态。

结果持久化，按需导出 Excel 和完整 JSON。Excel 超长文本分段且按文本写入。上传原文件可独立删除；任务删除清理题目、结果和文件。运行任务停止完成后才能删除。

进度区分成功、错误、手动停止；预计时间动态估计。原始文件和结果保留30天，终态任务自动清理，也支持手动删除。

## 本地运行

沿用当前DATABASE_URL，新增迁移 `20261112090000_ai_evaluation_tasks`，只增加独立任务表。前后端分别运行 `npm run build`；后端使用现有启动方式，不增加云资源。

服务重启后，在途轮次标记中断，依赖它的后续轮次失败；其他独立会话继续执行。用户停止的任务绝不自动续跑。重新开始复制原配置和题目，使用新ID和空历史。

## API

前缀 `/api/ai/evaluation`，使用现有员工会话鉴权。Python可通过CookieJar保存登录会话，不硬编码凭证。

- `GET /template?kind=single|multi&locale=zh-CN|en-GB&example=true|false`：下载模板。
- `POST /validate`：multipart，file为xlsx、config为JSON；返回questions/errors/total，不调用模型。
- `POST /tasks`：JSON包含config、questions、可选原文件base64 source、可选submissionKey。网络重试使用相同submissionKey避免重复创建。
- `GET /tasks`、`GET /tasks/:id`：当前员工任务；列表最近50条。
- `POST /tasks/:id/stop`：停止；取消在途请求完成前保持stopping。
- `POST /tasks/:id/restart`：终态任务从头重跑，不续跑。
- `DELETE /tasks/:id/source`：仅删除原Excel；`DELETE /tasks/:id`：删除终态任务和结果。
- `GET /tasks/:id/export?format=json|xlsx&locale=zh-CN|en-GB`：完整JSON或Excel。
- `POST /sessions`：单题交互会话，固定配置，不保存密钥。空闲30分钟或服务重启后需要新测试。
- `POST /sessions/:id/answer`：SSE，使用message/history及ChatStreamDto要求的courseId/mode；实际配置由服务端会话确定。

config字段：courseId、releaseId、model、runningSolution（grounded-jack/dialogue-yong）、locale、modes（LECTURE/SOCRATIC数组）、kind（single/multi）。questions字段：conversationId、turn、question、notes。

## 验证范围

中英文单轮/多轮模板往返、公式拒绝、超长答案分段、200份回答限制、停止竞态、片段保留、账号隔离、重启中断、全局锁及普通聊天状态保留。自动验证使用假模型，不产生模型费用。

## 本次改动文件

- client/src/pages/AITutor.tsx
- client/src/components/ai/EvaluationPanel.tsx
- client/src/components/ai/evaluationText.ts
- client/src/api/ai.ts
- client/tests/ai-evaluation.test.tsx
- server/src/ai/evaluation-contract.ts
- server/src/ai/evaluation-contract.spec.ts
- server/src/ai/evaluation-excel.ts
- server/src/ai/evaluation-excel.spec.ts
- server/src/ai/evaluation-execution.ts
- server/src/ai/evaluation.controller.ts
- server/src/ai/evaluation.service.ts
- server/src/ai/evaluation.service.spec.ts
- server/src/ai/ai-chat.service.ts
- server/src/ai/ai-chat.service.spec.ts
- server/src/ai/ai-chat-yong.service.ts
- server/src/ai/ai-chat-yong.service.spec.ts
- server/src/ai/dto/dialogue-test-stream.dto.ts
- server/src/ai/rate-limit.service.ts
- server/src/ai/ai.module.ts
- server/src/app.module.ts
- server/prisma/schema.prisma
- server/prisma/migrations/20261112090000_ai_evaluation_tasks/migration.sql
- docs/AI_Testing.md
- docs/Learning_Guide_BackOffice_Agent_Development_Document.md

## 2026-11-12 调整
单题最多两组独立配置左右对比，同题并行发送，多轮各自维护历史。批测配置独立。只提供Lecture/Socratic两份示例，统一Conversation ID/Turn/Question/Notes，单轮和多轮由会话轮次表达。文件内Test表固定Mode并在导入时校验。取消空白下载与回答语言选择，不追加语言指令，沿用原Prompt。旧记录仍可查看与重新开始。

本次调整文件：

- client/src/components/ai/EvaluationPanel.tsx
- client/src/components/ai/TutorComparison.tsx
- client/tests/ai-evaluation.test.tsx
- client/tests/ai-comparison.test.tsx
- server/src/ai/evaluation-excel.ts
- server/src/ai/evaluation-excel.spec.ts
- server/src/ai/evaluation.controller.ts
- server/src/ai/evaluation.service.ts
- server/src/ai/evaluation.service.spec.ts
- server/src/ai/evaluation-execution.ts
- server/src/ai/ai-chat.service.ts
- docs/AI_Testing.md

验证：前端lint、tsc、build通过，ai-comparison/ai-evaluation/ai-tutor-runtime/ai-tutor-history/ai-tutor-undo共14项通过。后端相关文件eslint、tsc、build通过，evaluation.service/evaluation-contract/evaluation-excel/ai-chat.service共79项通过。未启动后端、未调用真实模型。此前输出预算策略的6项失败断言不属于此次调整，未修改。

## 紧凑布局与内滚动
单Tutor配置一行四项；双Tutor左右排列，各侧两行两项。弹窗最大85vh，标题/页签/配置/输入固定，回答各侧独立滚动，只有在底部时跟随新回答。批测配置放下载示例上方，模式可选且以页面为准，不由Excel标记覆盖；切换模式保留题目。预览/任务列表/结果内部滚动。

此次改动：EvaluationPanel.tsx、TutorComparison.tsx、evaluation.css、evaluation.controller.ts、evaluation.controller.spec.ts及本说明。

## 合并远程 dev（2026-11-12）

基线更新至 afde5fa，保留远程课程管理、历史、修订保护、Society 更新及白屏修复，恢复本地 AI 测试。7处文本冲突已解决，同名新增文件按 Jack/Yong 拆分后的实现合并。界面文案接入 L 或翻译字典，模型参数旧断言按当前策略更新。

验证：前端完整526项、后端相关233项通过；前后端 lint、type check、build通过；Prisma schema有效；生产构建登录页正常，无启动异常。

本地 ZIP 源码备份和 stash 均保留。仅准备暂存，不创建提交、不推送；后端保持关闭。
数据库7个待应用迁移未执行：

- 20261103120000_helpdesk_faq_release_eval_runs
- 20261106000000_helpdesk_eval_stage_cache
- 20261109000000_helpdesk_faq_change_pipeline
- 20261112000000_course_version_content_hash
- 20261112010000_course_event_append_only
- 20261112020000_course_draft_revision
- 20261112030000_course_category_society

### 数据库同步完成

用户确认后，已先备份本地 PostgreSQL 数据库，再执行仓库原有的7个待应用迁移，未修改迁移SQL。`prisma migrate deploy`成功，`prisma migrate status`显示数据库已是最新状态，`prisma validate`通过。
核对7张相关表的新增字段、3个追加式保护触发器以及唯一的Society顶级分类均正常。备份和验证记录保存在忽略目录`.tmp/database-sync-backup.json`、`.tmp/database-sync-verification.json`；待推送记录中的数据库待迁移数量已更新为0。仅同步本地数据库，未操作云端数据库，未启动后端，未提交或推送。
使用已有Vite前端和假API进行了浏览器布局验证：单Tutor四项同排，双Tutor各两排；长回答超过内部可视高度，整体弹窗不增加滚动；批测配置位于下载链接之前。未启动、重启或关闭后端，未调用真实模型。
