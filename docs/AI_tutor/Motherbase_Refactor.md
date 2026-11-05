# AI Tutor 母版迁移实施记录

## 1. 授权与范围

用户于 2026-11-04 确认以相邻 `AITutor-main` 为基座重构 BackOffice Tutor，分支 `AI_Tutor_改进版`，基线 `af89717`。母版只读。实现沿用 NestJS、React、Provider、KS 契约和现有依赖，不修改 schema、环境配置或 CI；2026-11-05 经用户追加授权调整构建分包，见 §8。

母版通用流程依据 `services/dialogueTestingStore.ts` 的 buildDialogueRequest / streamDialogueMessage；数学显示依据 convoy-exhibit/mathematical-text.tsx。移植教学上下文、连续历史和增量生成，不引入母版的 Next.js 路由、文件会话存储或固定课程模型。

## 2. 保留契约

- 后台读取 aiTestReleaseId ?? currentReleaseId，Offline 课程仍可试跑；学员仅 currentReleaseId 且必须 Online；Group Study 服务端固定 Lecture。
- Set Live、编辑版本和新建 Release 的现有语义不变。AI 配置以 courseId + releaseId 为单位；模型与 Welcome 在同一配置内跨模式共享。
- MAIN / Lecture / Socratic / Assessment 均保留 Save / Reset。MAIN 仅与 Lecture / Socratic 拼接；Assessment 独立，实际评分后置。新 Release 不复制四套自定义 Prompt 内容。
- 默认值保持自定义 > 绑定模板 > 默认模板 > 文件；MAIN 自定义 ?? 文件。已有自定义不被默认模板更新覆盖。
- 对外 SSE 保持 delta / done / error，既有两个 chat-stream 路径兼容。后台新增可选 expectedReleaseId，仅校验本次屏幕版本，不能借此指定其他版本；学员 DTO 不接受此字段。

## 3. 当前实施步骤

1. 固定兼容性测试和本文；每阶段记录真实验证结果。
2. 单次读取配置快照后解析 Prompt 与 Provider；提取通用 Tutor 上下文和消息编译。小 Release 使用完整快照（UTF-8 bytes/4 工程估算 <= 6000 tokens）；大 Release 使用现有有预算检索，始终保留完整页面目录。估算不代表 provider usage；空快照、归属错误、读取失败明确失败，不能把故障当成无命中。
3. 知识层沿用已有专项检索回归；从主编排提取到上下文模块，逐项替换需要实际课程证据，不能以重构为由丢失这些优化。学习状态/Planner 尚未生成时仍显式标记，不宣称已完成诊断闭环。
4. 逐块转发正文。可见首段前最多两次瞬态重试；可见正文后不静默重试，截断与上游错误发 error，日志保留部分正文。无正文且 reasoning 耗尽可受控重试。取消信号传到 Provider。
5. 后台存储 v2 key 按员工 / 课程 / Release 隔离；旧无归属历史不自动迁入。模式共享会话，Lecture 最近六轮、Socratic 十轮；只有完整成功轮次进入下一轮。失败/取消片段保留且标状态。请求结束仅更新其发起上下文。
6. 保留 Markdown + KaTeX，支持 $ / $$ / \\( \\) / \\[ \\]；保护代码和公式，引用仅转换正文。Sources 单独渲染；流中未闭合公式暂按文本。实际 DOM 回归验证公式、链接、代码、来源与 HTML 边界。
7. lint → type check → 定向测试 → build / 全套单测；不启动浏览器，UI 由用户验收；真实模型教学成绩另报。

## 4. 后续工作

多路线管理员试跑、确定性展品适配、服务端持久学习状态、实际 Assessment 评分独立推进。首轮不新增数据表或引入框架，不用母版的人文评分标准替代 Modeling Life 的评分设计。

## 5. 验证与交接

2026-11-04 首轮工程实现已落地：单次配置快照、完整小 Release 上下文、大包检索、编译 Prompt hash、逐块输出、取消与失败终态、账号/Release 会话隔离、公式/引用 AST 渲染和中英文错误映射均已接入主链。默认 MAIN 补入当前焦点、结束信号与公式格式，已存自定义配置保留。

SIR、鹰鸽、特征值等专项检索及来源层级规则已提取至上下文模块并保留回归，尚未替换为课程侧显式元数据。学生状态与 Planner 仍明确未生成。小包 6000 为 UTF-8 bytes/4 工程估算，不代表模型真实 token 计量。

正文显示后不再静默重试；仅无可见正文的特定输出额度耗尽保留一次重试。Provider 的错误帧、畸形数据和缺结束标记 EOF 明确失败，reader 结束/取消时释放。Socratic 孤立 Sources 尾部暂存，合法引用仍逐块显示。运行日志仅新增 Prompt hash，不保存完整 Prompt。

验证环境 Node v24.15.0，离线假 Provider / jsdom，无真实模型花费：

| 目录 | 命令 | 结果 |
|---|---|---|
| server | 相关生产源码、新增模块与 Provider/Logger 测试只读 ESLint（完整命令见下） | 通过 |
| server | `npx --no-install tsc --noEmit --incremental false` | 通过 |
| server | `npm test -- --runInBand` | 116 suites / 1770 passed，11 suites / 166 skipped；跳过项未计通过 |
| server | `npm run build` | 通过 |
| client | `npm run lint` | 通过，有既有 warnings；最终 `npm run lint -- --quiet` 通过 |
| client | `npx --no-install tsc --noEmit -p tsconfig.app.json` | 通过 |
| client | `npm test` | 完整套件 500 passed |
| client | Tutor + i18n 最后调整后定向回归（命令见下） | 22 passed |
| client | `npm run build` | 通过；保留现有大 chunk 警告，未改打包配置 |

后端定向命令：

```powershell
npx --no-install eslint src/ai/ai-chat.service.ts src/ai/ai-config.service.ts src/ai/ai-chat-logger.ts src/ai/ai-chat-logger.spec.ts src/ai/tutor/course-context.ts src/ai/tutor/course-context.spec.ts src/ai/tutor/dialogue-runtime.ts src/ai/tutor/dialogue-runtime.spec.ts src/ai/providers/openrouter.provider.ts src/ai/providers/openrouter.provider.spec.ts src/ai/dto/chat-stream.dto.ts
```

前端定向命令：

```powershell
node --experimental-strip-types --import ./tests/support/register.mjs --test --test-timeout=15000 tests/ai-tutor-history.test.ts tests/ai-tutor-undo.test.tsx tests/ai-tutor-markdown.test.tsx tests/ai-tutor-runtime.test.ts tests/i18n-guard.test.ts
```

后端全仓只读 `npx --no-install eslint "{src,apps,libs,test}/**/*.ts"` 仍为 **695 errors / 11 warnings**。对本次所有变动的 tracked TS，使用 ESLint.lintText(HEAD 源码, 当前 filePath) 与当前文件逐一比较：ai-config spec 33 → 33，ai-config service 1 → 0，provider spec 1 → 0，其余变动文件 0 → 0；新增模块和相关生产源码定向检查通过。没有执行 --fix 或批量修复无关代码。

开发自检已做，**未取得独立 Review Agent 的 APPROVE**；没有浏览器、真实模型、数据库 e2e 或线上验收。当前不能视为所有发布门禁已通过，没有 commit / push / 部署。

## 6. 手动验收入口

1. 在现有开发环境的 AI Tutor 选择课程和测试 Release，检查四个 Prompt 分段 Save / Reset 与共享模型、Welcome。
2. 保持课程 Offline，在后台询问课程知识，确认逐块回答；学员端对应课程仍不可访问。
3. 切测试 Release 检查历史隔离，切回恢复；换员工账号不显示原账号对话。
4. 检查行内/块公式、Sources 与复制 Markdown；生成中停止，确认片段标为已停止，下一轮不携带失败轮。
5. 另一员工修改共享测试版本后，在旧页面发送应提示版本已变化；刷新后使用新版本。按已有流程 Set Live、Online 后，分别验收个人 Lecture/Socratic 与 Group Study Lecture。


## 7. Changed files

- `client/src/api/ai.ts`
- `client/src/backoffice/lib/i18n/serverText.ts`
- `client/src/backoffice/messages/en-GB.json`
- `client/src/backoffice/messages/zh-CN.json`
- `client/src/components/ai/ChatWindow.tsx`
- `client/src/components/ai/TutorMarkdown.tsx`
- `client/src/components/ai/normalizeTutorMarkdown.ts`
- `client/src/pages/AITutor.tsx`
- `client/src/stores/aiStore.ts`
- `client/tests/ai-tutor-history.test.ts`
- `client/tests/ai-tutor-markdown.test.tsx`
- `client/tests/ai-tutor-runtime.test.ts`
- `client/tests/ai-tutor-undo.test.tsx`
- `docs/AI_Collaboration_Log.md`
- `docs/AI_tutor/Motherbase_Refactor.md`
- `docs/AI_tutor/开发日志.md`
- `docs/Learning_Guide_BackOffice_Agent_Development_Document.md`
- `server/src/ai/ai-chat-logger.spec.ts`
- `server/src/ai/ai-chat-logger.ts`
- `server/src/ai/ai-chat.service.spec.ts`
- `server/src/ai/ai-chat.service.ts`
- `server/src/ai/ai-config.service.spec.ts`
- `server/src/ai/ai-config.service.ts`
- `server/src/ai/dto/chat-stream.dto.ts`
- `server/src/ai/prompts/main.md`
- `server/src/ai/providers/openrouter.provider.spec.ts`
- `server/src/ai/providers/openrouter.provider.ts`
- `server/src/ai/tutor/course-context.spec.ts`
- `server/src/ai/tutor/course-context.ts`
- `server/src/ai/tutor/dialogue-runtime.spec.ts`
- `server/src/ai/tutor/dialogue-runtime.ts`

## 8. 遗留检查清理（2026-11-05）

按用户要求处理全仓遗留检查：后端由 695 errors / 11 warnings 降至 0 / 0，前端由 61 warnings 降至 0。保留检查规则，未使用 ignore/disable 或提高阈值。

- 后端：为 HTTP 测试响应、Jest mock 调用、Express 回调和模块工厂补齐实际类型；修正枚举比较、无效 async、冗余断言、控制字符检查和格式错误。找回密码的邮箱限流改为等待结果后发信，避免异步绕过限流。
- KS：新增查询向量契约与注入令牌，KnowledgeModule 通过 useExisting 复用现有 EmbeddingService；新增离线模块装配回归。移除 Chunking 中未调用的 headingKey 和只供它使用的 slugify，分块逻辑不变。
- 前端：组件与工具/Context 导出拆开以支持 Fast Refresh；表单和目录树按输入变化重置，异步结果在请求回调内采用，保留手动重试和分页。MarkdownToolbar 用 useSyncExternalStore 订阅编辑器状态，时间戳在事件中采样。
- 回归：覆盖限流等待与拒绝、媒体控制字符、Excel 异常值、KS 注入、课时/语言切换、工具栏订阅、旧分页响应隔离。修正 HelpDesk 测试的 act 等待与路由调用，完整前端测试无 React act 警告。

| 位置 | 命令 | 结果 |
|---|---|---|
| server | `npx --no-install eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 0` | 0 errors / 0 warnings |
| server | `npx --no-install tsc --noEmit --incremental false` | 通过 |
| server | `npm test -- --runInBand` | 119 suites / 1784 passed，11 suites / 166 skipped |
| server | `npm run build` | 通过 |
| client | `npx --no-install oxlint --deny-warnings` | 0 errors / 0 warnings |
| client | `npx --no-install tsc -b --pretty false` | 通过 |
| client | `npm test` | 112 suites / 503 passed，无 React act 警告 |
| client | `npm run build` | 通过；34 个 JS 文件，最大 293019 bytes，无构建警告 |
| repo | `git diff --check` | 通过 |

用户于 2026-11-05 确认加入分包规则后，已写入 client/vite.config.ts：app/vendor 两组的 maxSize 均为 750000，保留原 500 kB 警告阈值。实际构建输出 34 个 JS 文件，最大 293019 bytes，超过 500000 bytes 的文件为 0，构建日志无警告；完整前端测试再次通过 503 项且无 React act 警告，lint 和类型检查通过。分包改变文件粒度，不代表按路由懒加载或总下载体积减少。

分支仍为 AI_Tutor_改进版；AITutor-main 未修改。没有新增依赖、修改 schema / 环境 / CI / 锁文件，也未 commit / push / 部署。独立 Review、手动 UI/真实模型验收及数据库 e2e 仍待执行；跳过用例未计作通过。

### 本轮相关文件清单

含导出拆分的引用位置；上一轮母版迁移清单保留在 §7。

- `client/vite.config.ts`

- `client/src/backoffice/ShellRoute.tsx`
- `client/src/backoffice/components/Pagination.tsx`
- `client/src/backoffice/components/StudentDrawer.tsx`
- `client/src/backoffice/components/UploadProgress.tsx`
- `client/src/backoffice/helpdesk/EnquiriesView.tsx`
- `client/src/backoffice/helpdesk/EnquiryList.tsx`
- `client/src/backoffice/lib/workspaceAccess.tsx`
- `client/src/backoffice/pages/CourseEditorPage.tsx`
- `client/src/backoffice/pages/CourseManagementPage.tsx`
- `client/src/backoffice/pages/CoursePreviewPage.tsx`
- `client/src/backoffice/pages/EmployeeAccountPage.tsx`
- `client/src/backoffice/pages/HelpDeskPage.tsx`
- `client/src/backoffice/pages/LearningAccessPage.tsx`
- `client/src/backoffice/pages/ModulePages.tsx`
- `client/src/backoffice/pages/OperationsPage.tsx`
- `client/src/backoffice/pages/PortalCoursePreviewPage.tsx`
- `client/src/backoffice/pages/SignInPage.tsx`
- `client/src/backoffice/pages/StudentManagementPage.tsx`
- `client/src/backoffice/pages/course-editor/CourseContentSection.tsx`
- `client/src/backoffice/pages/course-editor/CourseInfoSection.tsx`
- `client/src/backoffice/pages/course-editor/CourseTrialSection.tsx`
- `client/src/backoffice/pages/course-editor/CourseVersionsSection.tsx`
- `client/src/backoffice/pages/course-editor/ExhibitDrawer.tsx`
- `client/src/backoffice/pages/course-editor/TextEditor.tsx`
- `client/src/backoffice/pages/course-editor/UnderstandingPanel.tsx`
- `client/src/backoffice/pages/course-editor/shared.tsx`
- `client/src/components/ai/ConfigPanel.tsx`
- `client/src/components/knowledge/CourseTree.tsx`
- `client/src/components/knowledge/MarkdownToolbar.tsx`
- `client/src/components/knowledge/PageEditor.tsx`
- `client/src/components/knowledge/PublishPanel.tsx`
- `client/src/components/knowledge/SyncButtons.tsx`
- `client/src/components/knowledge/TagManager.tsx`
- `client/src/components/knowledge/i18n.ts`
- `client/src/components/ui/Tag.tsx`
- `client/src/components/ui/index.ts`
- `client/tests/ai-tutor-history.test.ts`
- `client/tests/ai-tutor-undo.test.tsx`
- `client/tests/course-editor-history.test.ts`
- `client/tests/course-time-input.test.ts`
- `client/tests/helpdesk-enquiries.test.tsx`
- `client/tests/helpdesk-faqs-ui.test.tsx`
- `docs/AI_Collaboration_Log.md`
- `docs/AI_tutor/开发日志.md`
- `docs/Engine_Split_Implementation.md`
- `docs/Learning_Guide_BackOffice_Agent_Development_Document.md`
- `server/src/ai/ai-config.service.spec.ts`
- `server/src/ai/helpdesk/helpdesk-suggest.controller.spec.ts`
- `server/src/ai/helpdesk/helpdesk-suggest.service.spec.ts`
- `server/src/ai/helpdesk/release-answerer.ts`
- `server/src/ai/helpdesk/workflow/pi-step-runner.spec.ts`
- `server/src/backoffice/modules/helpdesk/faqs/faqGraphRepository.ts`
- `server/src/backoffice/nest/auth.controller.ts`
- `server/src/backoffice/tests/helpdesk-faq-graph-rbac.spec.ts`
- `server/src/backoffice/tests/helpdesk-faq-markdown.spec.ts`
- `server/src/backoffice/tests/helpdesk-faq-release-model-gate.spec.ts`
- `server/src/backoffice/tests/helpdesk-pii-corpus.spec.ts`
- `server/src/backoffice/tests/route-access.spec.ts`
- `server/src/commerce-courses/commerce-courses.module.ts`
- `server/src/commerce-courses/commerce-courses.service.ts`
- `server/src/commerce-courses/course-authoring.service.ts`
- `server/src/commerce-courses/course-summary.spec.ts`
- `server/src/commerce-courses/course-summary.ts`
- `server/src/commerce-courses/docx-to-html.spec.ts`
- `server/src/commerce-courses/docx-to-html.ts`
- `server/src/commerce-courses/excel-package.spec.ts`
- `server/src/commerce-courses/excel-package.ts`
- `server/src/commerce-courses/heavy-tasks.ts`
- `server/src/commerce-courses/media-stream.ts`
- `server/src/commerce-courses/media-validate.ts`
- `server/src/commerce-courses/operations.service.ts`
- `server/src/commerce-courses/package-importer.spec.ts`
- `server/src/commerce-courses/package-importer.ts`
- `server/src/commerce-courses/package-jobs.service.ts`
- `server/src/commerce-courses/portal-courses.controller.ts`
- `server/src/commerce-courses/portal-projection.service.ts`
- `server/src/common/access-log.spec.ts`
- `server/src/common/build-version.spec.ts`
- `server/src/common/filters/all-exceptions.filter.spec.ts`
- `server/src/common/filters/all-exceptions.filter.ts`
- `server/src/knowledge/chunking.service.ts`
- `server/src/knowledge/knowledge.module.ts`
- `server/src/ks/prisma-knowledge.client.ts`
- `server/src/main.ts`
- `server/src/releases/releases.service.spec.ts`
- `server/src/sync/sync.controller.ts`
- `server/src/sync/sync.service.ts`
- `server/src/tags/tags.service.spec.ts`
- `server/test/ai.e2e-spec.ts`
- `server/test/backoffice.e2e-spec.ts`
- `server/test/commerce-courses-workflow.e2e-spec.ts`
- `server/test/files.e2e-spec.ts`
- `server/test/knowledge.e2e-spec.ts`
- `server/test/portal-projection.e2e-spec.ts`
- `server/test/tags.e2e-spec.ts`
- `client/src/backoffice/components/paginationState.ts`
- `client/src/backoffice/employeeSession.ts`
- `client/src/backoffice/lib/workspaceAccessState.ts`
- `client/src/backoffice/pages/course-editor/shared-utils.ts`
- `client/src/backoffice/pages/course-editor/versionHistory.ts`
- `client/src/components/ai/TutorMarkdown.tsx`
- `client/src/components/ui/tagColors.ts`
- `client/tests/ui-state-regressions.test.tsx`
- `docs/AI_tutor/Motherbase_Refactor.md`
- `server/src/backoffice/tests/auth-rate-limit.spec.ts`
- `server/src/commerce-courses/media-validate.spec.ts`
- `server/src/knowledge/knowledge.module.spec.ts`
- `server/src/ks/contract/embedding-client.ts`
- `server/test/helpers/http-response.ts`
