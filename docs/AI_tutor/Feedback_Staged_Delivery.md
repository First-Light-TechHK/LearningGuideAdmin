# AI Tutor Feedback 分阶段交付

依据：用户 2026-11-12 的设计截图与范围确认，以及 2026-11-13 的分阶段测试要求。
范围：只做 Backoffice 管理页面，Portal 暂不接入。沿用 AI Tutor 工作区、aiTutor 权限和中英文。原始问题、回答、专家建议、知识用途、上下文和提报人独立保留。参考 Excel 位于工作区 outputs/01a1cf37-4382-7051-a5c8-0c358c446c62/。

| 阶段 | 可交付内容 | 可测试结果 | 状态 |
|---|---|---|---|
| 1 | Feedback Tab、示例列表、组合筛选、分页和空结果 | 可进入并检索指定案例，切回 Tutor 不丢配置或聊天 | 代码和自动检查已交付，待用户界面验收 |
| 2 | 详情抽屉、目标问答和前序上下文、专家建议、知识用途、运行记录只读视图 | 可定位目标回答，缺失上下文或 trace 有明确提示 | 代码已交付，待手动验收 |
| 3 | Triage 表单、状态流转、处理记录、员工隔离的本地演示保存 | 分类、关闭、重开和刷新后读取均可测试，缺验证依据不能 Applied | 代码与自动验证已交付，待手动 UI 验收 |
| 4 | 权限与异常场景回归、完整人工验收清单 | VIEW 无写操作，切换员工隔离，窄屏和长文本可操作 | 代码与自动验证已交付，待手动 UI 验收 |

真实 API/数据库、Excel 批量入库、Portal 提交与运行采集为后续集成阶段，不计入上述管理页面阶段。

## 阶段 1 设计

- 顶部同级 AI Tutor / Feedback，保留 Tutor 挂载，Tab 切换不重新初始化配置和对话，也不取消正在运行的回复。Feedback 列表在首次打开时挂载，切回保留筛选。
- 2026-11-13 验收调整：Tab 间距与 KnowledgeTabBar 共用 `tokens.spacing['2xl']`（48px）。当前课程选项仍从示例反馈记录去重生成，未接映射课程；后续课程来源待用户确认。本次调整后等待用户回复，不推进阶段 2。
- 本轮调整验证：lint、tsc、7 项 Feedback 定向测试和 build 通过；build 保留 chunk 体积警告；独立增量 Review APPROVE，手动界面验收待用户执行。
- Feedback 复用工作区 MenuGuard 和 WorkspaceAccessProvider。阶段 1 只有读取，不新增独立菜单或角色。
- 数据源为独立、只读的 typed mock adapter；不调用 Portal、不新增服务端路由或数据库表。界面明确标注示例数据，反馈内容不执行 HTML。
- 列表显示编号、Student/Expert、课程/课时、反馈、提报人、提交时间、状态。模式参与筛选，完整问答和专家字段保留在记录类型中，供阶段 2 展示。
- 按课程、类型、模式、状态、最近 7/30 天和关键词组合筛选；关键词覆盖问题、回答、专家建议、反馈、提报人和编号。最近天数按滚动 24 小时窗口，包含下界，不包含未来时间。默认不限时间，防止固定示例过期后列表消失。
- 筛选变化回到第一页，重置恢复全部；分页每页 5 条。按提交时间倒序。无结果显示清空筛选入口。

## 阶段 2 设计（2026-11-13）

列表新增详情入口，右侧抽屉只读展示原问题、目标回答、前序上下文、反馈原文、专家建议、知识用途和 Runtime Trace。未采集的字段明确提示，不重建历史运行信息。首期所有内容为示例，课程来源不变；关闭详情保留列表筛选和分页。不提供 Triage 保存或状态修改。

人工验收：进入 Feedback，打开 DEMO-001，核对专家建议和上下文；打开 DEMO-002，核对空建议提示；打开 Runtime Trace 查看“未采集”提示；关闭抽屉后列表筛选保留。正文作为文本显示，不执行 HTML。

## 阶段 1 手动测试

已有本地环境：client 下执行 `npm run dev`，使用现有服务端和员工账号登录。由当前 Vite 地址进入 `/en-GB/ai-tutor` 或 `/zh-CN/ai-tutor`，点击 Feedback / 反馈。

| 操作 | 预期 |
|---|---|
| 打开 Feedback | 显示示例数据提示、6 条记录、第一页 5 条 |
| 下一页 | 显示剩余 1 条 |
| 输入 DEMO-002 | 唯一匹配，自动回第一页 |
| 课程选 Modelling Life，类型 Student，状态 New | 仅 DEMO-002 |
| 搜索不存在的文本 | 显示空结果，可清空筛选 |
| 重置筛选 | 恢复 6 条 |
| 搜索 shark | 通过原问题匹配 DEMO-001 |
| 切换中英文 | UI 文案跟随语言，课程正文与用户原文保留 |
| Tutor 编辑配置但不保存，切换 Feedback 再切回 | 原编辑内容保留，聊天不重新初始化 |
| VIEW 员工打开 | 可读列表，不出现新增、保存、删除等写按钮 |

自动检查按 lint → type check → 单测 → build 执行。仓库禁止浏览器自动操作，UI 活体验收由用户执行。阶段交付不等于用户已验收。

## 阶段 1 验证记录（2026-11-13）

在 client 下执行：

- `npm run lint`：通过，无 lint 提示。
- `npx tsc -b --pretty false`：通过。
- `node --experimental-strip-types --import ./tests/support/register.mjs --test tests/ai-tutor-feedback.test.tsx`：7 passed。
- `npm test`：533 passed，0 failed。
- `npm run build`：通过，有超过 500 kB 的 chunk 体积警告；未修改构建配置。集成测试使用原 Tutor 时输出既有 Tooltip overlayInnerStyle 废弃提示，不影响断言。
- 独立 Review Agent：APPROVE，Blocking / Non-blocking 均无。
- 未启动浏览器，未执行人工 UI 验收；未接入真实反馈，未 commit / push / 部署。

## 阶段 1 改动清单

- `client/src/App.tsx`：接入抽出的 AI Tutor 工作区。
- `client/src/pages/AITutor.tsx`：顶部 Tab。
- `client/src/pages/AITutorWorkspace.tsx`：Tab 与保留挂载逻辑。
- `client/src/pages/AITutorFeedback.tsx`：列表、筛选、分页、空结果。
- `client/src/api/feedback.ts`：记录类型、只读示例数据源和筛选逻辑。
- `client/src/backoffice/messages/en-GB.json`、`client/src/backoffice/messages/zh-CN.json`：中英文文案。
- `client/tests/ai-tutor-feedback.test.tsx`：逻辑、组件及工作区集成回归。
- `docs/Learning_Guide_BackOffice_Agent_Development_Document.md`：设计入口。
- `docs/AI_tutor/Feedback_Staged_Delivery.md`：阶段计划、验收步骤与证据。
- `docs/AI_Collaboration_Log.md`：交付日志。

## 阶段 2 验证记录

2026-11-13：lint、tsc 通过；Feedback 定向测试 9 passed；完整测试 535 passed；build 通过，有既有 chunk 体积警告。独立 Review APPROVE；未操作浏览器，待用户手动验收。改动：AITutorFeedback.tsx、api/feedback.ts、两个语言 JSON、ai-tutor-feedback.test.tsx 及本文和协作日志。

## 阶段 3/4 设计
新增独立处理覆盖层：问题类型、处理结果、备注、变更引用、验证依据及追加历史。New 可诊断或关闭，Triaged 可诊断/关闭/落实，关闭记录须有原因才能重开为 Triaged。Applied 必须有实际改动与验证，关闭生成 resolvedAt，重开清空。按员工使用版本化 localStorage，仅保存处理覆盖值，不修改原始问答。损坏/未知版本保留原值并禁写，写入失败不更新页面。VIEW 只读。员工切换重建页面隔离草稿。未保存关闭需确认，窄屏表单自动换行。课程仍为 mock，不接服务端。


## 阶段 3/4 手动验收

1. 以 Admin/Operation AI 登录，打开 Feedback → DEMO-001。选择问题类型、Classified only，填写备注，保存后应为 Triaged，刷新后记录保留。
2. 选择 Knowledge updated 或 Prompt updated，未填写变更引用/验证依据时 Applied 必须拒绝；补齐后成功，记录关闭时间和操作历史。
3. 在已落实记录填写新的重开原因再重开，状态回到 Triaged，关闭时间清空，历史仍保留。关闭成功后立即重开但不填新原因必须拒绝。
4. 选择 No action needed，填写原因后关闭；没有原因拒绝。关闭抽屉有草稿时需确认放弃。
5. 切换 VIEW 员工可查看记录，但无保存/关闭/重开控件；切换员工不显示前员工浏览器保存或草稿。
6. 本地存储不可读、写入配额不足或覆盖层损坏/版本未知时显示错误，禁写且保留原始值；修复浏览器存储后刷新重试。
7. 窄屏检查详情自动单列、表单换行；超长备注自动换行；原始问答、用户反馈保持只读。

本轮新增/修改：api/feedbackTriage.ts、components/ai/FeedbackTriage.tsx、pages/AITutorFeedback.tsx、中英文 JSON、tests/ai-tutor-feedback-triage.test.ts、tests/ai-tutor-feedback-triage-ui.test.tsx、本文与 AI_Collaboration_Log.md。现有 48px Tab 间距、课程 mock 和 Portal 边界不变。

验证：lint、tsc 通过；Feedback 9 + Triage 领域 9 + Triage 组件 6 共 24 项相关测试通过；完整单测 550 passed，0 failed；build 通过（已有 chunk 体积警告）。独立 Review APPROVE。首次全量出现一项未修改的 helpdesk-graph-ui 焦点测试失败，单独 21 项复核及随后全量均通过，原因未确定，未修改 Helpdesk。浏览器实测未执行，由用户按上述步骤验收。日志 phase34-*.log 位于 client，受 Git 忽略。无 commit/push/部署。
