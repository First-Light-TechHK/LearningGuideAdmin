# AI 协作日志（Learning Guide BackOffice）

> 规范（2026-10-14 用户确立）：每完成一个 Phase 或做出重大决策，必须将【AI协作日志】落盘本文档。
> 新条目追加在最前（倒序）。条目字段：日期 / 任务 / 用户拍板 / 变更清单 / 自测证据 / 审查结论 / Git / 下一步。

---

## 2026-10-29 ｜ Helpdesk 推荐 v2：pi-agent-core 工作流 + 链路追踪 + 评测（Admin server + client，Portal 配合）

- **用户拍板**：owner Oliver Zhang（2026-10-28）：不要自主 agent 循环；每一步用原样的 pi-agent-core 跑，步骤由我们写死的工作流决定；追踪照 DeepSeek Harness 的 SessionEvent。方案 `lg-helpdesk/helpdesk-agent-v2-pi-dsh.md`。
- **变更清单**（设计文档 §4A.8、§4A.11、§5.4、§5.5、§8）：
  - server：`ai/helpdesk/workflow/`（`engine.ts` 步骤表、`faq-workflow.ts`、`pi-step-runner.ts`）取代旧的 `complete()` + json_schema 路径（旧代码删除）。每个 agent 步只给一个工具，参数枚举锁定，`terminate: true`。闸门：`beforeToolCall` 白名单、一步最多一次调用、`finishTurn` 结束、到期 abort。`@earendil-works/pi-agent-core` / `pi-ai` 1.4.0 不打补丁，server `engines` 改为 Node ≥ 22.19。
  - server：迁移 `20261029120000_helpdesk_agent_events`（只追加的事件日志，90 天清学员原文）、`trace/`（事件存储、RunTrace、traceparent、查询），以及 BackOffice 只读接口 `GET /api/helpdesk/agent-runs/:runId`、`…/events/:seq`（helpDesk VIEW，导出副本脱敏）。接口经契约 `HELPDESK_TRACE_SOURCE` 注入，`BackofficeModule.register({ helpdeskTrace })`。
  - server：`/suggest` 收 `runId` / `parentRunId` 与 `traceparent`，客户端断开即 abort。契约样例升到 v3（三份同一文件）。
  - client：每个 AI 块的「View trace / 查看链路」只读抽屉（`TraceDrawer.tsx`、`lib/helpdeskTrace.ts`）。
  - 评测：`server/eval/helpdesk/`（120 条用例、种子 FAQ、`npm run eval:helpdesk`、`eval.spec.ts` 进 `npm test`）。
  - `setup.sh` / `setup.ps1` / README 改为 Node ≥ 22.19（`scripts/node-version.test.mjs` 锁住）。
  - Portal（同名分支）：`traceparent` 头、预生成 run id、`parentRunId`（Portal `docs/phase1/helpdesk-tickets.md` §18）。
- **学员可见行为不变**：模型只选候选 id 或 none，答案为库内原文；任何失败返回 null、不阻塞建单；Portal ↔ Admin 契约向后兼容。
- **自测证据**：
  - server：`npm run build` 通过；`npm test`（带 `HELPDESK_TEST_DATABASE_URL`，本地临时 PG 16）53 套件、635 通过 + 1 个仓库原有 skip；`npm run test:scripts` 15/15；改动文件 `npx eslint` 无新增问题。
  - client：`npm run build` 通过，`npm test` 264/264，`npx oxlint` 0 错误（17 条警告，与基线相同）。
  - 评测（假模型）：`npm run eval:helpdesk` 内存检索与 `--pg` 各跑通一次，报告写出。没有真实 OpenRouter key，**没有真模型成绩**。
- **待视觉验收**：链路抽屉与「View trace」按钮在 AI 块上的位置（无画板）。
- **开放问题**：①需要有 key 的人跑一次真模型评测并看闸门；②内存检索只是近似，与生产一致要用 `--pg`；③部署镜像 `node:22-alpine` 须 ≥ 22.19。
- **Git**：分支 `claude/project-thread-pn4rf0`，未推送。

---

## 2026-10-28 ｜ HelpDesk v1 完整审查修复（Admin client + server + CI）

- **任务（用户）**：「在fork上跑一遍ci 完整review一遍」「不要引入新的问题 查uiux 后端 打边角用例 看测试锁住功能没有 测试覆盖面」。本条修完整审查里 repo = backoffice 的已核实问题，每条先写失败用例再改。
- **用户拍板（不改）**：OPEN 咨询显示 Claim / 接单；Mark as reviewed = propose_resolution 一次点击、不加确认框；Student ID = Portal 用户 id；不做埋点；界面跟 Figma，不改样式，布局只在问题需要时改，且 1672 宽必须与现状一致。
- **变更清单**：
  - server：列表查询参数重复 / 非文本一律 400（控制器参数改为 `unknown`，全局 ValidationPipe 不再把数组 String() 成 `a,b`）；问题 / 答案 / 关键词与推荐的学员原文拒绝控制字符（400，不再 500 / 白调模型）；推荐 3.5 秒总期限（Portal 等 4 秒），过期答案不记 `qa_id`；`CANDIDATES_SQL` 改为全文分支（走 GIN）UNION 关键词 / 双字分支再打分（5000 行本地实测 63 ms → 10 ms），PG 用例对真实 SQL 做 EXPLAIN；90 天清理用例断言新行保留原文；Portal 客户端锁住不跟随重定向、5 / 10 秒超时，附件代理锁住 `Content-Security-Policy: default-src 'none'`。
  - client：写操作结果只作用于发出请求的那条咨询（切走后不再把旧咨询换进来、不在新咨询上提示），busy 按咨询区分；回复框 Idempotency-Key 只在正文与模式都没变时沿用；搜索框跟随地址栏、防抖用最新参数；搜索词 / 标签 all 不再被吞；标签输入与 Ctrl+Enter 在输入法组字时不提交；编辑弹窗 409 后取最新版本并保留草稿、404 关闭；保存成功 toast；中栏最小 420px（1672 宽像素级不变）；删除卡片看板遗留文案。组件逻辑抽成 `lib/helpdeskView.ts` / `lib/helpdeskQuestions.ts` 的纯函数，`tests/helpdesk-flows.test.ts` 锁住（未引入 jsdom）。
  - CI：server job 加 `postgres:16` 服务与 `HELPDESK_TEST_DATABASE_URL`（PG 用例在 CI=true 且没库时直接失败，不再静默跳过）；client job 加 `npm test`；job 名不变；`scripts/ci-workflow.test.mjs` 锁住。
- **未改**：Mark as reviewed 不加确认（用户拍板）。
- **Git**：分支 `claude/project-thread-pn4rf0`，已提交未推送。

---

## 2026-10-28 ｜ HelpDesk v1 审查修复（Admin client + server）：Claim 接单、mark_read 带 sequence、全文索引表达式

- **任务**：协调方转来的审查结论，逐条先核实再修；用户原话见下方各条（「拿 TDD 开发锁住」「现在先不做埋点」）。
- **核实结论**：①新建（OPEN）咨询上没有任何接单入口，「Mark as reviewed」要等第一次公开回复后才出现——属实（spec §7 列有 Claim，状态表规定 propose_resolution 只在 ASSIGNED / WAITING_USER）；②`helpdesk_questions_search_idx` 用 `'simple'`，候选查询用 `'english'`，索引永远用不上——属实（迁移未进任何远端分支，原地修改）。
- **变更清单**：
  - client：`lib/helpdeskView.ts` 新增 `claimInput` / `markReadInput`，`EnquiryControls.claim`（FULL 且 Server `available.claim`）；`EnquiryConversation.tsx` 在 Enquiry 卡片底部、Mark as reviewed 的位置显示「Claim / 接单」（复用 `hdMarkReviewed` 样式，不新增 CSS）；`EnquiriesView.tsx` 接单走 `runAction`（409 stale 重新加载）；打开即已读改为带 `expectedSequence`（Portal 只在 sequence 未变时清未读）；en-GB / zh-CN `helpDesk` 段新增 4 个文案。
  - server：迁移索引改为 `to_tsvector('english', question || ' ' || answer)`，导出 `CANDIDATES_SQL`；新增 `helpdesk-questions-search-index.spec.ts`（索引表达式与查询表达式一字不差、只用 english）；PG 套件新增 EXPLAIN 用例（关闭顺序扫描后命中该索引）。
- **TDD 证据**：client 先改 `tests/helpdesk-view.test.ts`，运行失败（`claimInput` 不存在）；server 新 spec 与 PG 用例先跑 3 个失败（`'simple'` ≠ `'english'`、`CANDIDATES_SQL` 未导出）；实现后全绿。
- **自测证据**：client `npm test` 70/70、`npm run build` 通过、`npx oxlint <改动文件>` 0 错误（2 条 HEAD 已有的 set-state-in-effect 警告）；server `npm run build` 通过，`npm test` 41 套件通过 + 2 个 PG 套件跳过；设 `HELPDESK_TEST_DATABASE_URL`（本地临时 PG 16）后 43/43 套件、441 通过 + 1 个仓库原有 skip；`npx eslint <改动文件>` 0 问题。
- **待视觉验收**：OPEN 咨询卡片底部显示「Claim / 接单」而 Figma 1324:2 画的是「Mark as reviewed」，待产品 / 视觉确认。
- **开放问题**：候选查询把全文命中与关键词 / 中文双字命中用 OR 合并，即使表达式一致，规划器仍会扫描该语言下的已发布问题（表很小，结果正确）；若问题库变大，可拆成全文分支 UNION 关键词分支再合并打分。本地联调库 `lg_admin_int` 已跑过旧版本迁移，校验和会变，重建该临时库即可。
- **Git**：分支 `claude/project-thread-pn4rf0`，已提交未推送（推送由协调方处理）。

---

## 2026-10-28 ｜ HelpDesk v1 两端联调（Portal + Admin server + Admin client）

- **任务（用户）**：「只要把工单这个流程做好，页面做好，UI 做好 … 拿 TDD 开发锁住」；Figma addendum（QA 知识库数据层 / Agent / Student / Backoffice）。本条是把 Portal 与 BackOffice 在本地真跑起来、互相调用，修联调中发现的问题。
- **联调环境（只用本地值）**：本地 PostgreSQL 16 + pgvector（`prisma migrate deploy` 全部迁移）；Admin server（`PORTAL_HELPDESK_BASE_URL/TOKEN`、`ADMIN_HELPDESK_TOKEN` 为本地测试值；模型走本地假 OpenRouter 端点，没有真实 key）；Admin client（vite）；Portal dev（DEV + 本地存储，`ADMIN_HELPDESK_BASE_URL/TOKEN` 指向本地 Admin）。脚本在 `lg-helpdesk/integration-harness/`。
- **端到端（Playwright，Portal 仓库 `tests/e2e/helpdesk-integration.spec.ts`）**：员工建并发布 3 个常见问题（1 个精选）→ 学员只看到精选那个 → 提交匹配问题的咨询 → AI 助手弹窗 →「No, still submit」带截图 → Enquiries 行有未读点 → 打开即清、学员信息 / 订阅「—」、加标签、内部备注、回复 → 学员只看到回复 → 学员再回复，行重新未读 → Mark as reviewed → 学员确认 → BackOffice 显示 Closed；「Yes, this solved my issue」不建单、计数 solved；VIEW 角色无任何写控件且不发写请求；zh-CN 两端（含有订阅的学员）。7/7 通过，连跑两次。
- **联调发现并修复（先写测试见红再改）**：
  1. Portal 订阅投影会给 `semiannual`、`cancel_at_period_end`、`grace`，页面没有文案，直接显示原值 → client 两种语言补文案，`grace` 用琥珀色胶囊。
  2. Server 接受 `expectedSequence: 0`，Portal 只认 ≥1 → Server 自己 400 `INVALID_INPUT`，不再转发。
  3. Portal 的 400（`validation_failed` 等）被转成 `VALIDATION_FAILED`，页面没有文案 → 统一成 `INVALID_INPUT`；补 `TAG_LIMIT_REACHED` 文案。
  4. txt / csv 附件经 Admin 代理后丢了 `charset=utf-8` → 转发时保留。
  5. 两个方向的 401 代码不一致（Admin `unauthorized`，Portal `invalid_token`）→ Admin 改为 `invalid_token`，并带 RFC 6750 `error="invalid_token"`。
- **契约锁定**：`helpdesk-contract.json`（server、client 各一份，与 Portal 仓库同一份）+ server `helpdesk-contract-fixture.spec.ts` + client `helpdesk-contract.test.ts`，见设计文档 §4A.6。
- **自测证据**：server `npm run build` 通过；`npm test` 40 套件通过 + 2 个 PG 套件跳过（420 通过）；带 `HELPDESK_TEST_DATABASE_URL` 42/42 套件、438 通过；改动文件 `npx eslint` 0 问题。client `npm test` 67/67；`npm run build` 通过；`npx oxlint` 改动文件 0 问题。
- **开放问题**：「Mark as reviewed」= propose_resolution 仍是假设；新建（OPEN）的咨询要先回复才能 Mark as reviewed（状态机只允许 ASSIGNED / WAITING_USER），Figma 上新咨询也画了这个按钮，待产品确认。
- **审查结论**：待 Review Agent 审查。
- **Git**：分支 `claude/project-thread-pn4rf0`，已提交未推送（推送由协调方处理）。

---

## 2026-10-28 ｜ HelpDesk v1（Figma 补充，Admin 前端）：Enquiries 三栏 + Common Questions

- **任务（用户）**：「只要把工单这个流程做好，页面做好，UI 做好 … 按照我们原有的 UI UX 风格 … 拿 TDD 开发锁住」；「现在先不做埋点」；Figma node 1324-2「QA知识库数据层 / Agent / Student / Backoffice，页面还会有一些变动的」。本条只做 Admin **client**（server 未改）。
- **用户拍板**：`lg-helpdesk/tickets-v1-figma-addendum.md` §A / §D（与原方案冲突以它为准）：Help Desk 页头 +「+ Add Question」+ Enquiries / Common Questions 两个 Tab；Enquiries 三栏取代卡片看板；VIEW 只读。
- **设计同步**：开发文档 §1.1、§4A 头注（待视觉验收范围）、§4A.1 前端文件清单、§4A.4（详情并入三栏）。
- **变更清单（client）**：
  - 删除卡片看板与 `HelpDeskTicketPage.tsx`；`App.tsx` 两条 help-desk 路由合并为 `help-desk/:ticketId?`（同一 MenuGuard / WorkspaceAccessProvider）。
  - `pages/HelpDeskPage.tsx` + `backoffice/helpdesk/`：左栏搜索（300ms 防抖写地址栏）、筛选弹层（状态 / 类型 / 标签）、头像（按学员 id 固定配色）、时间（今天 HH:mm，否则「16 May」）、未读红点、选中蓝条、滚动加载；中栏 Enquiry 卡片、附件 chip、Mark as reviewed、之后的消息（内部备注琥珀虚线）、回复 / 内部备注；右栏学员信息、订阅、标签增删；打开即 `mark_read`（仅 FULL）；409 stale 重新加载并提示一次。
  - Common Questions：antd 表格（语言 / 类型 / 状态筛选 + 搜索、推荐 / 解决 / 未解决计数、编辑、发布 / 下线 / 归档 / 重新发布、单语言下上移下移整表排序）、新增 / 编辑弹窗（语言、类型、问题、答案、关键词、精选、立即发布；版本冲突刷新列表）。
  - `lib/helpdeskView.ts`、`lib/helpdeskQuestions.ts`（纯逻辑）、`lib/helpdeskApi.ts`（新接口）、`contracts/helpdesk.ts`（与 server 新形状一致）、`helpdesk.css`（只新增 `hd*` 类）、en-GB / zh-CN `helpDesk` 段（只替换该段，其它行不动）。
  - 测试设施：`client/tests/support/register.mjs`（Node 自带类型擦除 + 补扩展名 / JSON 导入），`package.json` 新增 `npm test`；无新依赖。
- **TDD 证据**：先写 4 个测试文件（view / questions / api / messages+wiring），运行确认失败（模块不存在、文案与路由未改，11 个用例里 10 个失败）；实现后 62/62 通过。
- **自测证据**：`client`: `npm test` 62 通过；`npm run build`（tsc -b + vite build）通过；`npx oxlint <改动文件>` 0 错误、4 条 react 规则警告（同类警告仓库已有）。`server`: `npm run build` 通过，`npm test` 39 套件通过 + 2 个 PG 套件跳过（409 通过）。本地桩 API + vite + Playwright（无头）跑了 13 项行为检查并截图（en-GB / zh-CN、FULL / VIEW），截图与 Figma 对比图在 `lg-helpdesk/tickets-v1-shots/`。
- **待视觉验收**：筛选弹层、日期分隔文字、状态胶囊、之后的消息与内部备注、回复框、空态、只读提示条、Common Questions 表格与弹窗；图标按同名描边图标重画（Figma 资源下载被代理拦截）。
- **开放问题**：「Mark as reviewed」= propose_resolution（假设，待产品确认）；Claim 按钮与事件时间线不在 Figma，已移除；头像 / 标签颜色按 id / 文本固定取色，与 Figma 示例的具体颜色不会一一对应。
- **审查结论**：待 Review Agent 审查。
- **Git**：分支 `claude/project-thread-pn4rf0`，已提交未推送（推送由协调方处理）。
- **下一步**：用户视觉验收；与 Portal 联调后用真实数据冒烟。

---

## 2026-10-28 ｜ HelpDesk v1（Figma 补充，Admin 服务端）：常见问题库 + 坐席推荐答案 + Portal 集成接口

- **任务（用户）**：「只要把工单这个流程做好，页面做好，UI 做好 … 拿 TDD 开发锁住，直接去实现」；「可以发 workflow」；「现在先不做埋点」；Figma（node 1324-2）「QA知识库数据层 / Agent / Student / Backoffice，页面还会有一些变动的」。本条只做 Admin **server**；client 由下一个 Agent 实现。
- **用户拍板**：`lg-helpdesk/tickets-v1-spec.md` + `lg-helpdesk/tickets-v1-figma-addendum.md`（两者冲突以补充文档为准）：常见问题（Common Questions）存在 Admin 库、员工维护；学员提交前由 Agent 引擎从已发布问题里挑一条原样展示；Portal 经 `/api/integration/helpdesk/**`（Bearer `ADMIN_HELPDESK_TOKEN`）读取与上报。
- **设计同步（先改文档）**：开发文档 §1.1 / §2 / §4A.1 / §4A.3（看板改为 Enquiries 列表）/ §4A.4（学员与订阅卡片）/ §4A.5 / §4A.6，新增 §4A.7（常见问题数据层）、§4A.8（推荐答案）、§4A.9（集成鉴权与豁免），重写 §5.4、新增 §5.5，§8 新增两个环境变量。
- **变更清单（server）**：
  - 迁移 `20261028090000_helpdesk_questions`（`helpdesk_questions` + 只追加的 `helpdesk_question_revisions`，CHECK 约束、英文全文 GIN、关键词 GIN、`(locale,status,sort_order)` 索引）与 `20261028090100_helpdesk_suggestions`；`schema.prisma` 同步三个模型。
  - `backoffice/modules/helpdesk/questions/`：Repository（`UPDATE … WHERE id AND version` 乐观锁，修订行同事务写入；排序 `FOR UPDATE` 全成全败；候选检索 = 全文 + 关键词 + 中文双字片段，同类 ×1.25，前 8）+ Service（状态机 draft ⇄ published → archived、可重新发布，版本冲突先于状态判断，归档后不可编辑；计数取自推荐日志，失败按 0）。
  - `nest/helpdesk-questions.controller.ts`：员工端 `/api/helpdesk/questions…`（列表 / 详情 / 修订 / 新建 / 修改 / 发布 / 下架 / 归档 / 排序）+ 集成端 `GET /api/integration/helpdesk/questions`（强 ETag、304、`Cache-Control: no-cache`）。
  - `ai/helpdesk/`：`HelpdeskSuggestService`（限流 10 次/小时共用 `ai_rate_limit_hits`；无候选不调模型；OpenRouter 非流式 `complete()` + json_schema 枚举候选 id；非候选 → null；3 秒超时；任何错误 → null；`query_text` 90 天后惰性清除）、`PrismaHelpdeskSuggestionStore`（结果首写为准）、`HelpdeskSuggestController`（`POST /suggest`、`POST /suggestions/:id/outcome`，`no-store`）。
  - 引擎拆分：中立契约 `src/contracts/helpdesk-qa.ts`；ai 不 import backoffice、backoffice 不 import ai，只在 `app.module.ts` 组装（`AiModule.register({helpdeskQa})`、`BackofficeModule.register({helpdeskSuggestionStats})`）。
  - 鉴权：`route-access.ts` 新增 `helpdeskIntegration`（仅 `integration/helpdesk` 前缀豁免员工登录），`BackofficeAccessGuard` 只认 Bearer（`timingSafeEqual`，每次现读，空 → 503，错 → 401）；集成路由一律 RFC 9457 problem+json（`ProblemJsonFilter`；全局过滤器按路径委托，覆盖 JSON 解析错误与 404）。
  - 工单（§D）：Portal 客户端与 Service 新增 contactEmail / preview / unreadByAgent / tags / student / subscription，动作 add_tag / remove_tag / mark_read；列表改为 status / category / tag / q / cursor / limit 过滤；附件放宽为图片内联、pdf / txt / csv / docx / xlsx 以下载方式返回（≤ 10 MB）；Idempotency-Key 必须是 UUID。
  - 公共：`common/uuidv7.ts`、`common/problem.ts`、`common/guards/helpdesk-integration-auth.ts`、`common/filters/problem-json.filter.ts`；`server/.env.example` 新增 `ADMIN_HELPDESK_TOKEN`、`HELPDESK_SUGGEST_MODEL`（留空）。
- **TDD 证据**：先写 13 个 spec（新建 + 修改），运行确认失败：13 个套件红、29 个用例失败（模块不存在 / 新行为缺失）；再实现到全绿。
- **自测证据**：`npm run build` 通过；`npm test` 39 个套件通过 + 2 个 PG 套件跳过（409 通过、19 跳过）；设 `HELPDESK_TEST_DATABASE_URL` 指向本地临时 PG 16 后 41/41 套件、427 通过（1 个为仓库原有 skip）；`npx eslint <改动文件>` 仅剩 `all-exceptions.filter.ts` 中 HEAD 已存在的 9 条 `no-unsafe-enum-comparison`。端到端冒烟（本地构建 + 临时库 + 假 LLM，本地测试令牌）：FULL 新建 201 / VIEW 403、旧版本 409、无令牌 401 problem+json + `WWW-Authenticate`、ETag 304、推荐返回库内原答案、结果 solved→solved→declined 为 changed true/false/false、计数 {shown:1,solved:1,declined:0}、下架后 ETag 变化、第 11 次推荐返回 null、坏 JSON 400 problem。
- **待视觉验收**：无 client 改动；常见问题 Tab 与编辑弹窗、回复编辑器、学员端手风琴由 client Agent 按 Figma 实现后用户验收。
- **开放问题**：①推荐接口在 agent 角色、常见问题接口在 admin 角色，拆分部署时 Portal 只有一个 `ADMIN_HELPDESK_BASE_URL`，需要网关按路径转发；②Portal 需支持 category / tag 列表参数、新增摘要字段、student / subscription、tag 与 mark_read 动作（字段名差异只改 `portalHelpdeskClient.ts`）；③「标记已查看」暂映射 propose_resolution，待确认；④中文检索依赖关键词与双字片段。
- **审查结论**：待 Review Agent 审查。
- **Git**：分支 `claude/project-thread-pn4rf0`，已提交未推送（推送由协调方处理）。
- **下一步**：client Agent 实现常见问题与 Enquiries 页面；与 Portal 联调集成接口；用户配置 `ADMIN_HELPDESK_TOKEN`（与 Portal 同值）后冒烟。

---

## 2026-10-28 ｜ HelpDesk 工单 v1（BackOffice 部分）：工单卡片看板 + 详情 + Portal 集成客户端

- **任务（用户）**：「把工单这个流程做好，页面做好，UI 做好，每个工单就是一个小卡片在 Back Office 上 … 按照我们原有的 UI UX 风格去做设计 … 拿 TDD 开发锁住」；「现在先不做埋点」。v1 不做飞书同步、前端埋点、AI 客服。
- **用户拍板**：方案 `lg-helpdesk/tickets-v1-spec.md`（2026-10-28 批准）：Portal 是工单唯一写入方；BackOffice 只经 Portal 集成接口（Bearer 服务令牌）读写并注入员工身份；菜单 helpDesk VIEW 只读、FULL 可写。
- **设计同步（先改文档）**：开发文档新增 §4A（模块 C：HelpDesk 工单）、§5.4（接口）、§8（`PORTAL_HELPDESK_BASE_URL` / `PORTAL_HELPDESK_TOKEN`），§1.1 / §2 注明不建表。
- **变更清单**：
  - `server/src/backoffice/modules/helpdesk/portalHelpdeskClient.ts`：唯一 Portal 客户端；环境变量每次请求现读；5 秒 / 附件 10 秒超时；RFC 9457 problem+json → 统一错误码（Portal 401/403/`integration_disabled` → 503 `HELPDESK_NOT_CONNECTED`，不透传成员工会话失效）；字段名 camelCase / snake_case 归一化；附件只放行 png / jpeg / webp 且 ≤ 5 MB。
  - `helpdeskService.ts`：Tab → Portal 状态过滤、待回复判定（OPEN，或 ASSIGNED 且学员最后发言）、Tab 数量、各状态可用操作、输入校验（正文 1–5000、expectedSequence、工单 id 必须是 UUID、Idempotency-Key 格式）、注入当前员工为 agent（忽略请求体里的 agent）。
  - `server/src/backoffice/nest/helpdesk.controller.ts` + `backoffice.module.ts`：`/api/helpdesk/tickets…`、`/api/helpdesk/attachments/:id`（图片代理，`Cache-Control: private, no-store`、`nosniff`）。
  - `route-access.ts`：`/api/helpdesk/**` 归菜单 helpDesk，GET = VIEW，任何写 = CREATE（仅 FULL）。
  - 前端：`App.tsx` 用看板 / 详情替换 help-desk 占位页；新增 `HelpDeskPage.tsx`、`HelpDeskTicketPage.tsx`、`lib/helpdeskApi.ts`、`lib/helpdeskFormat.ts`、`contracts/helpdesk.ts`、`helpdesk.css`；en-GB / zh-CN `helpDesk` 文案。VIEW 角色不渲染任何操作控件。
  - `server/.env.example`：两个新变量（留空）。
- **TDD 证据**：先写 `helpdesk-portal-client.spec.ts`、`helpdesk-service.spec.ts`、`helpdesk-rbac.spec.ts` 与 `route-access.spec.ts` 新用例，运行确认失败（模块不存在 / 路由归 Admin-only）后再实现；变异检查：把 helpdesk 写接口改成 VIEW，RBAC 用例 4 条失败。
- **自测证据**：`server`: `npm run build` 通过；`npm test` 全部通过；`npx eslint <改动文件>` 0 问题；本地假 Portal（node http）冒烟：鉴权头、Idempotency-Key、409 stale 映射、附件代理、超时 504 均符合预期。`client`: `npm run build`（tsc -b + vite build）通过。
- **待视觉验收**：无 Figma 画板，界面沿用 backoffice.css 的卡片 / 按钮 / 筛选条 / 状态点 / 提示条，由用户手动验收。
- **开放问题**：Portal 集成接口由另一线程并行实现，`status=` 多值按逗号分隔、`counts` 按状态计数的约定需联调确认；字段名差异只需改 `portalHelpdeskClient.ts`。
- **审查结论**：待 Review Agent 审查。
- **Git**：分支 `claude/project-thread-pn4rf0`，已提交未推送（推送由协调方处理）。
- **下一步**：与 Portal 集成接口联调；用户手动冒烟（Admin / Operation Admin 可认领、回复、内部备注、请学员确认；其余角色只读）。

---

## 2026-10-28 ｜ AI Tutor Release 下拉：版本说明展示 + 滑动窗口

- **任务（用户）**：AI Tutor 对话头部的 Release 选择器下拉，要求：① 每个版本项下方展示 `revisionNotes`；② 版本数 > 5 时启用滚动窗口。
- **用户拍板（AskUserQuestion 三轮）**：revisionNotes **单行截断 + 省略号 + hover tooltip**；超过 5 个才启用滚动（`MAX_VISIBLE_RELEASES=5`，`max-height: 300px; overflow-y: auto`）；revisionNotes 为空时显示灰色占位「无版本说明」。
- **变更清单（设计文档先行）**：
  - `docs/Learning_Guide_BackOffice_Agent_Development_Document.md` §4.3.1：追加「版本说明展示」和「滑动窗口」两条 bullet
  - `client/src/components/ai/ChatWindow.tsx`：
    - 新增常量 `MAX_VISIBLE_RELEASES = 5`、`MAX_DROPDOWN_HEIGHT = 300`
    - `ReleaseSelector` 新增单一决策变量 `canScroll = releases.length > MAX_VISIBLE_RELEASES`（经验教训：条件收敛）
    - Dropdown 菜单项 label 由单行改为两行布局（flex column + minWidth 220px + padding）；第一行 versionTag + Live 徽章；第二行 revisionNotes（`whiteSpace:nowrap` + `overflow:hidden` + `textOverflow:ellipsis` 三件套）；外层包 Tooltip（仅 revisionNotes 非空时 `title` 有值，空时 `title=undefined` Tooltip 安全返回 children）
    - `menu.style` 条件设置：`canScroll ? { maxHeight: MAX_DROPDOWN_HEIGHT, overflowY: 'auto' } : undefined`（antd MenuProps 透传 style 到 `<ul>` 根元素）
    - 引入 `Tooltip` 从 `../ui`；Typography import 因未使用已移除
  - `client/src/backoffice/messages/zh-CN.json` / `en-GB.json`：`aiTutor` 命名空间新增 `noRevisionNotes`（zh「无版本说明」/ en「No version notes」）
- **类型与后端**：后端 `GET /api/courses/:id/releases` 已返回 `revisionNotes`，`ReleaseSummary.revisionNotes: string` 已存在于前端 API 类型，**无需后端改动**、**无 DB/migration 影响**
- **自测证据**：client `npx tsc --noEmit` EXIT=0；client `npm run build`（tsc -b + vite build）EXIT=0；`npm run lint`（oxlint）0 errors（14 条 warning 为既有项目问题）
- **审查结论**：test_agent **通过，0 Blocking**。代码审查覆盖 antd MenuProps.style 有效性（rc-menu MenuProps 继承 `HTMLAttributes<HTMLUListElement>`，style 天然包含）、Tooltip title=undefined 安全（antd tooltip.d.ts title 可选，title 空时直接返回 children）、单行截断 CSS 三件套正确性、canScroll 单一决策变量位置合理、边界（0/5/6 个 Release、空/纯空格 revisionNotes）全部覆盖。两条非阻断观察项：OBS-001 revisionNotes 行显式 color 导致选中态不变主色（设计选择，非 bug）；OBS-002 常量可后续提取到 tokens（锦上添花）。
- **Git**：未提交（待用户手动冒烟）
- **下一步**：用户手动冒烟验证（见下方清单）

---

## 2026-10-27 ｜ M5：行内格式按钮 toggle（再次点击取消）

- **任务（用户）**：工具栏粗体/斜体/删除线/行内代码/行内公式按钮只会无限叠加标记（如连续点加粗变成 `****text****`），要求「已处于该格式时再次点击取消」。
- **用户拍板**：方案为「包裹/剥离」toggle；三个风险点一并处理：R1 `*`/`**` 前缀歧义、R2 跨节点选区、R3 空选区光标在标记中间。
- **变更清单**：
  - `client/src/components/knowledge/markdownCommands.ts`：
    - 新增 `isWrapped(text, before, after)`：首尾匹配 + 剥离后内层不以同标记开头/结尾（防 `*` 半剥离 `**text**`）。
    - `wrapSelection` 重构为 `toggleWrap`：非空选区已包裹→剥离否则包裹；空选区光标夹在 `before|after` 间且两侧非同标记字符→剥离，否则插入 `before+after` 光标居中。保留 `wrapSelection = toggleWrap` 别名。
  - `client/src/components/knowledge/MarkdownToolbar.tsx`：5 个按钮改用 `toggleWrap`，tooltip 更新为「再次点击取消」。
  - `client/src/components/knowledge/MarkdownSourceEditor.tsx`：`Mod-b`/`Mod-i` 快捷键改用 `toggleWrap`。
- **风险点处理**：
  - R1 `*`/`**`：`isWrapped` 内层残留检测；空选区剥离前检查两侧相邻字符非同标记，避免 `***|***` 误剥离。
  - R2 跨节点选区（`**a** and *b*`）：首尾不匹配→走包裹，与主流编辑器一致，保留。
  - R3 空选区：`**|**` 剥离；其余位置插入标记对光标居中。
- **自测证据**：`npm run build` / `npm run lint` 通过；test_agent 纯函数验证 `isWrapped` 20/20、空选区剥离 17/17。
- **审查结论**：test_agent APPROVE（0 Blocking）。
- **Git**：未提交。
- **下一步**：用户手动冒烟（选中 text→B→`**text**`→B→text；`**|**` 中间点 B 剥离；View 角色无变化）。

---

## 2026-10-28 ｜ M5-bis：选区「包含」判定 + 行内公式 `$$` 修复

- **Bug（用户）**：`**粗体**` 中只选中「粗体」两个字点加粗，结果变成 `****粗体****` 而非取消加粗。期望：**只要选中加粗范围内的任何内容，点加粗就取消该加粗**；斜体/删除线/行内代码/行内公式同理。
- **根因**：原 `toggleWrap` 只检查选区文本本身是否首尾被标记包裹，不感知选区是否落在格式节点内部。
- **方案（用户确认）**：用 CM6 语法树查找「包含选区」的同类格式节点，命中则剥离该节点首尾标记，否则包裹。
- **变更（`markdownCommands.ts`）**：
  - `MARKER_NODES`：`**`→StrongEmphasis / `*`→Emphasis / `~~`→Strikethrough / `` ` ``→InlineCode。
  - `findContainingNode`：`resolveInner(from,1)` 向上走父链，找内容区间 `[node.from+beforeLen, node.to-afterLen]` **包含**选区的最内层节点（非空：`from>=innerFrom && to<=innerTo`；空：光标在 `[innerFrom,innerTo]` 内）。
  - `findContainingMath`：`$` 无语法节点，按行扫描（规则与 Live Preview 一致），找包含选区的 `$…$` 区间。
  - `mapPosAfterStrip`：选区位置映射到剥离后的新位置。
  - `toggleWrap` 重写：先按主选区判定 strip（语法树→行内扫描→兜底 `isWrapped`），命中则单次 dispatch 替换为 innerText；否则 `changeByRange` 包裹。
- **首轮 review 发现的 2 个 Blocking 及修复**：
  - **B1**：非空选区误用「重叠」判定，跨节点选区（`**a** xx **b**` 选 `a** xx **b`）被剥第一个节点。→ 改为「包含」判定 `from>=innerFrom && to<=innerTo`，跨节点走包裹。
  - **B2**：`findInlineMathInLine` 遇 `$$` 只前进 1 格，`$$E=mc^2$$` 被误判为行内公式并剥成 `$E=mc^2$`。→ 开/闭 `$` 处遇 `$$` 均前进 2 格，对齐 Live Preview。
- **自测证据**：`npm run build` / `npm run lint` 通过；test_agent 真实 CM6 树驱动 11 场景全通过（含 B1/B2 复现场景）。
- **审查结论**：test_agent APPROVE（0 Blocking，复审通过）。
- **Git**：未提交。
- **下一步**：用户手动冒烟（见下方清单）。

---

## 2026-10-27 ｜ M4：表格 Widget 就地可视化编辑 + 单元格行内 Markdown 渲染

- **任务（用户）**：表格只能手写 GFM 管道符太麻烦，要求支持像 Notion 那样点击编辑；并希望单元格内渲染 `**粗体**` / `$公式$` 等行内格式。
- **用户拍板**：方案 A（就地可编辑 Widget，预览态→编辑态）；单元格内支持行内 Markdown 渲染；暂不做拖选行列数的创建网格。
- **变更清单**：
  - `client/src/components/knowledge/markdownWidgets.ts`：
    - `TableWidget` 由只读改为双态：**预览态**（右上角 hover 显现「✎ 编辑表格」按钮，点击表格任意处也可进入）渲染 `<table>`，单元格通过新增的 `renderInline()` 渲染行内 Markdown（粗体/斜体/删除线/行内代码/行内公式/链接/图片，支持转义与嵌套）；**编辑态**单元格 contentEditable，工具条 `＋行`/`＋列`/`－行`/`－列`/`完成`；`Tab`/`Shift+Tab` 跳格（末尾 Tab 自动加行）、`Enter` 下一行同列、`Esc` 取消；失焦或点「完成」时 `syncCellsToTable()` + `serializeTable()` 写回。
    - 新增 `parseTable()` / `serializeTable()`（单元格内 `|` 转义为 `\|`）、`renderInline()`、`Align` 类型；`parseDestination` 从 blockWidgets 迁移至此（消除循环依赖）。
    - `TableWidget.eq()` 纳入 `editing` 标志，确保切换态时重建 DOM；`ignoreEvent()` 返回 `true`，Widget 自管交互。
  - `client/src/components/knowledge/markdownBlockWidgets.ts`：
    - 改为工厂 `createMarkdownBlockWidgets(getView)`，注入 view 给 Widget 用于 dispatch；新增 `setEditingTable` StateEffect 锁定正在编辑的表格范围（锁定期间 `decorateActive` 不对其应用「选区接触→回退源码」）。
    - 文档变化后自动清除编辑锁；`editing` 变化触发重建装饰。
  - `client/src/components/knowledge/markdownLivePreview.ts`：改为工厂 `createMarkdownLivePreview(getOccupiedLineRanges)`，与块层解耦。
  - `client/src/components/knowledge/MarkdownSourceEditor.tsx`：接线两个工厂，`getView = () => viewRef.current`。
  - `client/src/index.css`：`.cm-md-table-edit-btn`、`.cm-md-table-editing`、`.cm-md-table-toolbar`、`.cm-md-table-cell-edit` 等编辑态样式。
  - `docs/..._Development_Document.md` §3.3.2：更新第 7、8 条（表格单元格行内渲染 + 就地编辑）。
- **自测证据**：`npm run build` 通过（tsc + vite）、`npm run lint` 0 errors（12 条预存 warning 与本次无关）。
- **审查结论**：test_agent 首轮提出 4 项 Blocking（B1 链接 XSS / B2 View 角色可编辑 / B3 工具条失焦误提交 / B4 外部文档变更丢单元格输入），均已修复并复审通过。附带修复 N1（align 补齐）、N3（删行删列重置焦点）、N4（Shift+Enter 不插换行）、N6（图片 src 走 safeUrl）、N7（末尾 Tab/Enter 加行后焦点记忆）。
- **Git**：未提交。
- **下一步**：test_agent 审查 → 修复 → 用户手动冒烟（点表格进入编辑、Tab 跳格、加行加列、完成写回、单元格内 `**x**`/`$x$` 预览态渲染、Esc 取消）。

---

## 2026-10-27 ｜ AllExceptionsFilter 日志级别分级（4xx 不再误报 ERROR）

- **任务（用户）**：终端连续输出 `ERROR [AllExceptionsFilter] 请求处理异常: Sign in required`，询问是否有问题。
- **定位结论**：`Sign in required` 是 `INVALID_EMPLOYEE_ACCOUNT` → HTTP 401（未登录），属正常业务场景（会话过期）。但 `AllExceptionsFilter` 对**所有**异常统一用 `logger.error` 打印，导致 4xx 客户端错误被误报为服务器故障，污染日志、掩盖真正的 5xx 错误。连续 3 条是前端并发请求在首个 401 返回前已发出（竞态，非 bug），前端已有 401 拦截跳转登录页。
- **用户拍板**：直接修复。
- **变更清单**：
  - `server/src/common/filters/all-exceptions.filter.ts`：日志按最终 `status` 分级——`status >= 500` 用 `logger.error`（含 stack，服务器故障需告警），`status < 500` 用 `logger.warn`（4xx 客户端错误属正常业务）；日志消息格式改为 `请求处理异常 [status] message`，便于 grep。
  - `server/src/common/filters/all-exceptions.filter.spec.ts`：新增用例断言 4xx 调用 `warn` 且不调用 `error`；beforeEach 增加 `warn` mock。
- **自测证据**：server `npm test -- --runInBand` → **29 套件 / 185 用例全部通过**（新增 1 个）；server `npm run build` 成功。
- **审查结论**：test_agent **APPROVE**（Blocking=0）。Non-blocking：Prettier 折行已修复；枚举比较 lint 与既有代码风格一致，不单独处理。
- **Git**：未提交。
- **下一步**：无需手动验证（日志级别调整）。重启 dev server 后未登录访问接口，终端应显示 `WARN` 而非 `ERROR`。

---

## 2026-10-27 ｜ 修复上传 .md 文件后页面白屏（codeBlock/mathBlock 误转 math + 缺失错误边界）

- **任务（用户）**：上传 .md 文件后页面突然白屏。
- **定位结论**：`PageEditor.tsx` 的 `convertMathParagraphs` 第 2 步用 `Array.isArray(block.content)` 遍历所有带 content 数组的块（含 codeBlock），把代码块中的 `$var`、`$100` 等误转为 `math` 行内内容项。但 codeBlock 的 inlineContent spec 只支持 `text` 类型，BlockNote 渲染时遇到不支持的 `math` 类型抛出异常，整个 React 树崩溃 → 白屏。同时应用全局无 ErrorBoundary，任何渲染异常都会导致白屏。
- **用户拍板**：直接修复，无需方案讨论。
- **变更清单**：
  - `client/src/components/knowledge/PageEditor.tsx`：`convertMathParagraphs` 第 2 步条件增加 `block.type !== 'codeBlock' && block.type !== 'mathBlock'`（mathBlock 的 content 同为 plain，仅支持 text，一并跳过以防御 latex 内含 `$` 的边缘场景）。
  - `client/src/components/ErrorBoundary.tsx`（新增）：全局错误边界 class 组件，`getDerivedStateFromError` 捕获异常、`componentDidCatch` 控制台记录，fallback UI 用 antd `Result` 展示错误信息 +「重新加载」按钮。
  - `client/src/App.tsx`：在 `ConfigProvider` + `AntApp` 内部用 `<ErrorBoundary>` 包裹 `<Routes>`（确保 fallback UI 获得主题与 antd 上下文）。
- **自测证据**：client `npm run build`（tsc + vite build）成功；oxlint 0 errors（9 warnings 为项目原有）。
- **审查结论**：test_agent **APPROVE**（Blocking=0）。Non-blocking 建议：同步跳过 mathBlock（已采纳）；ErrorBoundary 实际触发需用户手动验证。
- **Git**：未提交。
- **下一步**：用户手动冒烟——上传含代码块（含 `$var`/`$100`）的 .md 文件，确认不再白屏、代码块 `$` 保留为文本；上传含 `$...$` 行内公式与 `$$...$$` 块公式的文件，确认公式正常渲染。

---

## 2026-10-27 ｜ 修复大文档导入后 sectionTag「+ 标签」按钮全部堆积左上角

- **任务（用户）**：500 页 PDF 整本导入后，页面编辑器里每个标题旁的「+ 标签」按钮全部堆在左上角（top:0, left:0）且重叠；另有公式/图片乱码（另见下一事项）。
- **定位结论**：`PageEditor.tsx` 用 `headingKey(level, text)` = `h{n}-{slug}` 同时作 React key 与 `tagItemRefs` key。大文档中标题文本大量重复（多个 "Chapter"、"1.1"），导致 `tagItemRefs.set(key, el)` 被同 key 覆盖——仅最后一个同 key 标签被定位，其余停在默认 `(0,0)`；同时 React 出现重复 key。
- **用户拍板**：先修 bug（标签定位），公式乱码单独评估方案。
- **变更清单**（仅 `client/src/components/knowledge/PageEditor.tsx`）：
  - 新增 `HeadingEntry{ sectionKey, uniqueKey }`：`sectionKey` 仍为 `h{n}-{slug}` 用于 sectionTags 数据存取（不破坏既有数据），`uniqueKey` = `sectionKey` + 出现序号（`#1`, `#2`...）用于 React key 与 ref，保证唯一。
  - `headingKeys: string[]` → `headingEntries: HeadingEntry[]`；新增 `headingEntriesRef` 供 MutationObserver 回调读取最新条目（避免闭包陈旧）。
  - `updateTagPositions` 改为按 **DOM 顺序索引**匹配 tag 元素（`headingEls[i] ↔ entries[i]`），不再按 key 查 ref。
  - `syncHeadings` 用 `occurrence` Map 生成 uniqueKey。
  - MutationObserver 回调加 rAF 节流（大文档每次按键不再重算数百个 `getBoundingClientRect`）。
  - JSX：`key`/`ref` 用 `entry.uniqueKey`，sectionTags 读写用 `entry.sectionKey`。
- **自测证据**：client `npm run build`（tsc + vite build）0 error；oxlint 0 error。
- **审查结论**：test_agent **APPROVE**（Blocking=0）。Non-blocking：rAF 节流已在本轮补上；工作树含上轮 Import 修复的配套变更（app-setup/filter/knowledge.ts），属同一大文档导入场景。
- **Git**：未提交。
- **下一步**：用户手动冒烟——重新导入 500 页 PDF，确认标签按钮分布在各标题右侧而非堆积左上角；编辑时不卡顿。

---

## 2026-10-27 ｜ 修复大文档 Import 误报「服务器内部错误」（body-parser 100KB 上限）

- **任务（用户）**：上传约 500 页 PDF（含文字/公式/图片），解析成功、点 Import 时报「服务错误」。
- **定位结论**：Import 经 `POST /api/courses/:courseId/pages` 以 JSON 提交整份 `contentMd`；Express body-parser 默认 JSON 上限 **100KB**，大文档在进入控制器前被 413 拒绝；该错误不是 `HttpException`，被 `AllExceptionsFilter` 落到默认分支 → **500「服务器内部错误」**。15MB 限制仅作用于 `/api/files/convert` 的 multipart，不覆盖 Import 的 JSON。
- **用户拍板**：先按**方案 A（最小改动）**修复并自测；若出现编辑器卡死等状况，再讨论拆分多页（方案 B）。
- **变更清单**：
  - `server/src/common/app-setup.ts`：新增 `JSON_BODY_LIMIT='25mb'`；`configureApp` 内在 `app.init()` 前注册自定义 json parser（先于 Nest 默认 100KB parser，body-parser 因 `_body` 已解析会跳过默认 parser）。
  - `server/src/common/filters/all-exceptions.filter.ts`：新增 `isEntityTooLarge()`（`type==='entity.too.large'` 或 413），映射为 **400 VALIDATION_ERROR +「请求内容过大，请拆分文档后重试」**；multer 的 413 仍走 HttpException 分支保留 15MB 文案。
  - `client/src/api/knowledge.ts`：`createPage` / `updatePage` 超时放宽至 120s（其余接口仍 15s）。
  - 测试：新增 `server/src/common/app-setup.spec.ts`（3 用例）、`all-exceptions.filter.spec.ts` 新增超限映射用例。
  - 设计文档 §10.1 追加 2026-10-27 修复说明（25MB + 413→400 语义 + 前端超时）。
- **自测证据**：server `npm test -- --runInBand` → **29 套件 / 184 用例全部通过**；server `npm run build`、client `npm run build` 均成功；改动文件已 prettier 格式化。
- **审查结论**：test_agent **APPROVE**（Blocking=0）。Non-blocking：① `knowledgeStore.refreshDetail` 仍走 15s `getCourse`（慢网大响应可能「建页成功却提示失败」，建议后续放宽或加轻量树接口）；② app-setup 单测仅验证委托调用，未做 adapter 级 limit 生效证明；③ 已补本日志。
- **Git**：未提交（等用户手动验证后按需推送分支）。
- **下一步**：用户手动冒烟——500 页 PDF 上传→Import 成功并自动选中新页；观察编辑器/KaTeX 是否卡顿；若卡顿则启动方案 B（按标题/体积拆分多页）。

---

## 2026-10-26 ｜ 默认 Prompt / Welcome 改为运行时文件兜底（方案 B，云端空库不再空白）

- **任务（用户）**：云端 App Runner 空库，生产镜像 `npm ci --omit=dev` 不含 ts-node，无法执行 `npm run prompts:sync`；导致 `GET /api/ai/prompts` 返回空、后台 AI Tutor 的 System Prompt / Welcome 两栏空白、对话 System Prompt 为空串。用户拍板按「方案 B：运行时只读兜底，不写库」修复。
- **用户拍板**：① 采用方案 B（应用启动不写库、不覆盖库内已有默认模板）；② 保留 `npm run prompts:sync` 作为主动落库手段；③ 先改设计文档再改实现（项目规则）。
- **变更清单**：
  - `server/src/ai/ai-config.service.ts`：新增 `PromptTemplateView`；`listPrompts()` 库内 `isDefault` 行优先，对缺失模式及空串字段按 `src/ai/prompts/` 文件默认值补齐（合成行沿用 `lecture-default` / `socratic-default` id），并用 `toPromptMode()` 过滤非法 mode；`resolvePrompts()` 的 System Prompt / Welcome 增加文件兜底（`DEFAULT_PROMPTS` / `defaultWelcome(mode,'zh-CN')`）。读路径无任何 `promptTemplate` 写操作。
  - `server/src/ai/ai-config.service.spec.ts`：新增 6 条用例（空库合成两条、部分缺行只补缺失模式、空串字段补齐、非法 mode 过滤、空库 resolvePrompts 回退文件、课程绑定模板 id 失效回退文件）。
  - `server/src/ai/prompt-defaults.ts`：注释说明这些文件同时是运行时兜底。
  - 设计文档 §2.1（Seed 例外说明）、§4.2.4（Reset 兜底）、§4.4.2 第 4 步（完整优先级链）、§5.2 接口表（`/api/ai/prompts` 合成口径）同步更新。
- **自测证据**：`npm test -- --runInBand` **28 套件 / 180 用例全部通过**；`npm run build` 0 error；`dist/ai/prompts`（lecture.md / socratic.md / welcome.yaml）存在，生产镜像具备文件兜底能力；未新增依赖、无密钥变更；优先级保持「课程自定义 > 绑定模板 > 库内默认模板 > 文件默认」。
- **审查结论**：test_agent 通过；Review Agent **APPROVE**（无 Blocking）。Non-blocking 已处理：mode 断言改为 `toPromptMode` 收窄、空串默认行补齐、换行格式；保留项：绑定模板 id 失效补 `findFirst`（外键 `ON DELETE SET NULL`，现网不可达）、e2e 内容断言（需 Postgres 测试库）、合成 id 不可回写（当前无绑定接口）。
- **Git**：未提交（等用户确认后按需推送分支）。
- **下一步**：用户手动冒烟——云端空库 `GET /api/ai/prompts` 返回两条非空默认模板；后台配置页 Lecture/Socratic 均有默认 System Prompt / Welcome；测试对话正常；学员端欢迎语不受影响。

---

## 2026-10-26 ｜ 课程同步数据源改为 KS 内置课程 ID 映射表（删除 Portal 目录拉取）

- **任务（用户）**：不再由 KS 运行时向 Portal 获取课程 ID；直接按当前 courseID 映射一份到 KS，KS 通过这份映射执行同步。原因：后期课程主数据归 BackOffice，KS 只需 courseID 即可；同时删除原先 KS 向 Portal 获取课程数据的实现。
- **用户拍板**：① 映射表只收录 Portal 真实 4 门课 ID（`epicureanism` / `stoicism` / `quintus-horatius-flaccus` / `modeling-life`）；② **同步目的不变**——仍同步课程标题 + lesson 结构化同步，当前无 lesson 数据故为空，不改变同步原有语义，只要课程能一一对应即可。
- **变更清单**：
  - 新增 `server/src/sync/course-registry.ts`：内置 courseID → 标题映射表（4 门），后续 BackOffice 接管时替换此数据源
  - 新增 `server/src/sync/catalogue-source.service.ts`：本地数据源，替代 `PortalSourceService`
  - 删除 `server/src/sync/portal-source.service.ts` 与 `portal-source.service.spec.ts`
  - `server/src/sync/sync.service.ts`：DI 改为 `CatalogueSourceService`；`listExternalCourses()` 改为「映射表课程 ∪ 本地带 externalId 的课程」，避免映射表外的本地课程从侧栏消失；映射表外课程执行同步返回 `unchanged: true`（不再 404）
  - `server/src/sync/sync.module.ts`、`sync.controller.ts`：provider 与注释同步
  - `server/.env.example`：删除 `PORTAL_API_BASE_URL` / `PORTAL_API_TOKEN`
  - `server/test/knowledge.e2e-spec.ts`：`overrideProvider(CatalogueSourceService)` 注入带 lesson 的假数据源，继续覆盖标题同步 + 课时建页算法
  - 新增 `catalogue-source.service.spec.ts`、`sync.service.spec.ts` 单元测试
  - 前端文案去掉 Portal 口径：`SyncButtons.tsx`（按钮「同步课程标题」）、`Sidebar.tsx`（「同步目标（课程 ID）」）、`knowledgeStore.ts`
  - 设计文档 §3.2.2 / §5.1.4 / §10 环境变量同步改拍说明
- **自测证据**：`tsc --noEmit` 0 error；`jest` 28 套件 / 174 用例全部通过（新增 sync 相关 10 用例）；`server`/`client` 构建均成功
- **审查结论**：待 test_agent 验证
- **下一步**：用户手动冒烟（侧栏选课 → 同步 → 新课程 `modeling-life` 是否建出）

---

## 2026-10-26 ｜ 密码规则改为 8–128 字符并在激活/重置页展示规则提示

- **任务（用户）**：密码长度调整为 8 到 128 个字符；仅做长度校验，不做大小写、数字、特殊字符等复杂度要求；在激活或重置设置密码的页面给出密码规则提示。
- **用户拍板**：直接按上述口径实施，完成后直接提交并推送到目标分支（`dev`）。
- **变更清单**：
  - `server/src/backoffice/lib/securityPolicy.ts`：`PASSWORD_MIN_LENGTH` 12 → 8（`PASSWORD_MAX_LENGTH` 保持 128）；`isPasswordAcceptable` 仍只校验长度
  - `client/src/backoffice/messages/en-GB.json` / `zh-CN.json`：新增 `passwordRule.hint` 文案
  - `client/src/backoffice/pages/ActivatePage.tsx`、`ResetPasswordPage.tsx`：在「新密码」输入框下以 `fieldHint` 展示规则提示
  - `docs/BackOffice_Portal_Implementation.md` §6.1：密码长度参数同步为 8–128
- **自测证据**：`server` / `client` 分别 `npx tsc --noEmit` 均 0 error；`jest src/backoffice/tests/password.spec.ts src/backoffice/tests/envelope.spec.ts` 10/10 通过；两份语言包 JSON 解析通过
- **审查结论**：改动为单常量 + 文案 + 提示渲染；UI 由用户手动验收
- **Git**：`dev` 已推送提交「feat(backoffice): adjust password rule to 8-128 chars and show rule hint」（本机到 github.com:443 直连超时，改用 GitHub API 写入同一 tree/提交内容）
- **下一步**：无

---

## 2026-10-24 ｜ KS Engine / Agent Engine 拆分（可独立部署、独立扩容）

- **任务（运维）**：Admin/Portal API、KS/Agent 引擎、数据层三份设计；两个系统深度联动但发版互不影响，KS 和 Agent 可独立扩容。
- **用户拍板**：画完架构图自审后，对照 admin 上游最新情况直接实施。
- **变更清单**：
  - 新增 `APP_ROLES`（admin / agent / ks），同一镜像按角色挂模块；不设时全起，行为不变
  - 新增 KS 契约 `src/ks/contract`，Agent 只经契约读 KS；同进程读库，拆开后经 `/api/ks/v1` + 服务令牌 + 3 秒超时
  - KS 不可达时 Agent 返回 503 `KS_UNAVAILABLE`
  - 限流从进程内存改到表 `ai_rate_limit_hits`（Prisma 迁移，空库可重放），多实例准确
  - ESLint 锁模块边界；开发文档 §2 补表；新增 `docs/Engine_Split_Implementation.md`
- **自测证据**：`tsc` 0 error；单测 162 通过 1 跳过；e2e 96 通过，2 条失败与改动前相同（`ai.e2e-spec` chat-stream 两条，基线即失败）；新增引擎拆分 e2e 4/4
- **审查结论**：自审；新文件 eslint 0 error，改动的既有文件未新增 lint 错误
- **Git**：分支 `feat/engine-split`（在 ccf1768 之上）
- **下一步**：拆库与去跨域外键、分开部署、Portal 服务令牌、KS 检索（见实施说明 §8）

---

## 2026-10-23 ｜ AI Tutor 进入时刷新 Release 列表（状态过期修复）

- **任务（用户）**：在 Knowledge Pages 新建 Release 后，AI Tutor 仍停留在旧 Release 列表；切换 Course 再切回才更新。要求只修状态刷新。
- **根因**：`aiStore` 为模块级单例，`App` 切换模块只卸载组件、不清空 store；`init()` 仅在 `selectedCourseId` 为空时调用 `selectCourse()`，因此切回 AI Tutor 不会重新拉取 `getConfig` / `listReleases`。
- **用户拍板**：方案 A，只修状态更新，不自动切换测试版本或 Live 版本。
- **变更清单**：
  - `client/src/stores/aiStore.ts` 新增 `refreshActiveCourse()`：并行重拉 `getConfig` + `listReleases`
  - `init()` 每次进入 AI Tutor 时刷新当前课程；课程已不存在则回退第一门课程
  - 有未保存配置改动时只刷新 `config` / `releases`，不覆盖 `form`；无改动时同步重建表单
  - 开发文档 §4.3.1 补充该刷新规则
- **自测证据**：`npm run build`（tsc -b + vite build）通过；`npm run lint` 0 errors（4 条既有 warning）
- **审查结论**：待 Review Agent 审查；UI 由用户手动验收
- **Git**：尚未提交

---

## 2026-10-23 ｜ 默认 Prompt / Welcome 文件化 + 通用本课欢迎语

- **任务（用户）**：① 重新设计默认 welcome（课程已选定，不再提示选择课程）；② 把默认 Lecture/Socratic Prompt 与 Welcome 从代码中独立出来，支持快速编辑。
- **用户拍板**：① 通用本课导师文案（中英文两版）；② MD + YAML 组合；③ 编辑后手动执行同步命令；④ 保留后台课程级覆盖编辑。
- **变更清单**：
  - 新增 `server/src/ai/prompts/lecture.md`、`socratic.md`（原 `agents/` 草稿原样迁入，作为默认 Prompt 唯一来源）
  - 新增 `server/src/ai/prompts/welcome.yaml`：Lecture/Socratic × `zh-CN`/`en-GB` 通用本课欢迎语
  - 新增 `server/src/ai/prompt-defaults.ts`：读取并校验文件；`promptTemplateSeeds()` 供 seed/同步共用
  - 新增 `server/src/ai/sync-prompts.ts` 与 `npm run prompts:sync`：只 upsert 两条默认模板，不触碰课程覆盖
  - `prisma/seed.ts` 删除硬编码 Prompt 常量，改读文件
  - `ai-config.service.ts`：学员 welcome 增加 locale；优先级为课程自定义 > 绑定模板 > 文件默认值
  - `ai.controller.ts`：welcome 接口支持 `?locale=zh-CN|en-GB`
  - `nest-cli.json`：构建时复制 `ai/prompts/*` 到 `dist/ai/prompts`
  - 依赖：新增 `js-yaml`（已有传递依赖，显式声明）；新增 `@types/js-yaml` dev 依赖
  - 修复 ts-node 运行：手写 `src/types/js-yaml.d.ts` 不会被 ts-node 默认加载（构建用 tsc 会加载），改为安装官方类型包并删除 shim
  - 文档：§2.1、§4.2.6、接口表同步
- **自测证据**：KS 全量单测 89 用例通过（含新增 3 条 welcome 优先级/locale 用例）；`npm run build` 通过且 `dist/ai/prompts` 三个文件已复制；`npm run prompts:sync` 执行成功，`lecture-default` / `socratic-default` 两条默认模板已写入新文案
- **注意**：同步只 upsert 两条默认 PromptTemplate，不修改任何 CourseAiConfig 课程覆盖
- **审查结论**：待 Review Agent 审查；UI 由用户手动验收
- **Git**：尚未提交

---

## 2026-10-22 ｜ 学员端 AI Tutor 欢迎语接口（Portal AI Tutor 右侧抽屉）

- **任务（用户）**：LearningGuidePortal 的 AI Tutor 弹窗需要展示 KnowledgeSystem 后台配置的 welcome 语；KS 现有学员接口只返回 `online/available`，不包含 welcome。
- **用户拍板**：① 新增 `GET /api/user/ai-tutors/:externalId/welcome`（自定义优先、模板兜底、只读 `currentReleaseId`）；② welcome 为空时 Portal 不显示欢迎气泡，不回退本地文案。
- **变更清单**：
  - `server/src/ai/ai-config.service.ts`：新增 `resolveLearnerWelcome(externalId)`，返回 `{ lecture, socratic }`；课程不存在 / 未开放 / 无上线版本分别 404 / 403 / 409
  - `server/src/ai/ai.controller.ts`：`UserAiController` 新增 `GET ai-tutors/:externalId/welcome`
  - `server/src/ai/ai-config.service.spec.ts`：补 welcome 解析与三种状态码单测
  - `docs/Learning_Guide_BackOffice_Agent_Development_Document.md`：§4.2.6 与接口表同步新端点
- **自测证据**：`npx jest src/ai/ai-config.service.spec.ts --runInBand` 17 用例全通过
- **审查结论**：待 Review Agent 审查（本次同时涉及 Portal 前端，UI 由用户手动验收）
- **Git**：尚未提交
- **下一步**：Portal 侧打开抽屉时调用该接口并渲染 welcome；welcome 为空则不展示气泡

---

## 2026-10-22 ｜ KS 目录栏 UI 调整（长标题省略 + H1-H6 层级 + 左移 + 收起把手）

- **任务（用户）**：① 长 lesson 名称不出现横向滚动条，改为省略号且不影响搜索；② 目录栏按 H1-H6 展示，需先确认展示方式；③ lesson 行左移，拖拽区最左侧与目录栏对齐并留呼吸空间；④ 导航列收起把手更窄、更高，右侧不越过目录栏左边缘。
- **用户拍板**：Heading 采用「缩进 + 引导线」；初始方案默认展示 H1-H3、H4-H6 收进「展开更多」。
- **后续改拍（同日）**：取消 H4-H6「展开更多」，H1-H6 全部直接展示；Heading 字号不再随层级变小；修复重复展开/缩进导致目录与正文出现重复 Heading/tag 的 bug。
- **变更清单**：
  - `client/src/components/knowledge/CourseTree.tsx`：
    - 新增 `PAGE_INDENT=6`、`HEADING_BASE_INDENT=28`、`HEADING_LEVEL_STEP=12`；Page 行左移，Heading 按 H1-H6 逐级缩进
    - H2-H6 渲染祖先层级竖向引导线；H1-H6 全部展示，移除「展开/收起 H4-H6」节点
    - Heading 字号统一为 `fontSize.md`，不再按层级递减
    - Heading Tree key 加入 index，避免同层级同文本的重复 key
    - 点击当前已选 Page 时不再调用 `selectPage`，只做展开/收起
    - 标题行改为 `flex + minWidth:0 + ellipsis`，右侧 chevron/菜单 `flexShrink:0`
  - `client/src/stores/knowledgeStore.ts`：`selectPage` 对「当前页 + 已有 draft」直接返回；并改为 `flushSave` 后重新读取 page，避免写回旧 `contentMd`
  - `client/src/components/layout/Sidebar.tsx`：树容器改为 `overflowY:auto / overflowX:hidden`，消除横向滚动条
  - `client/src/index.css`：Ant Tree 层级缩进归零（由 titleRender 接管）；Tree/TreeNode/content-wrapper/title 全部 `min-width:0`、`max-width:100%`，长文本省略
  - `client/src/components/layout/MainLayout.tsx`：导航列收起把手 `22×48 → 14×72`，字号 16→12，右侧边缘停在 Sider padding 内
- **重复 Heading 根因**：点击当前 Page 会同时触发 `selectPage`（重置 draft + 编辑器 `replaceBlocks`）和展开/收起；反复操作会叠加编辑器重载，导致目录与正文重复。已在 `handleSelect` 与 store `selectPage` 双重短路。
- **自测证据**：`npm run build`（tsc -b + vite build）通过；`npm run lint` 0 errors（仅既有 warning）
- **审查结论**：按用户要求不做浏览器自动化验证，UI 由用户手动验收。已存在的重复 Heading/tag 不会被自动删除，需要用户确认后再清理。
- **Git**：尚未提交
- **下一步**：用户手动验证 H1-H6 全量展示、字号一致、反复展开/收起不再产生重复 Heading，以及拖拽/收起把手尺寸

---

## 2026-10-22 ｜ 修复「无法同步 Portal 课程目录」（admin host 重定向 + 本地配置）

- **任务（用户）**：KS 课程管理报「未配置 PORTAL_API_BASE_URL 或 PORTAL_API_TOKEN，无法同步 Portal 课程目录」，要求先讨论再开发。
- **诊断结论**：
  - KS `server/.env` 缺少 `PORTAL_API_BASE_URL` / `PORTAL_API_TOKEN`，请求发出前即被 `PortalSourceService` 拒绝；
  - Portal DEV 下 `localhost` / `127.0.0.1` 属于 admin host，`/api/integration/catalogue` 不在 admin 白名单，middleware 返回 307 到 `/en-GB/backoffice`；
  - Portal `.env.local` 缺少 `PORTAL_INTEGRATION_TOKEN`，即使放行也会返回 503。
- **用户拍板**：按方案 A 执行——修 Portal admin 白名单 + 配置共享 Token，不采用 KS 直读 Portal 数据文件的方式。
- **变更清单**：
  - `LearningGuidePortal-dev/services/adminHost.ts`：`isAdminAllowedPath` 放行 `/api/integration/`（接口自身仍校验 Token）
  - `LearningGuidePortal-dev/tests/unit/admin-host.test.ts`：新增 admin host 下 `/api/integration/catalogue` 应 allow 的断言
  - `KnowledgeSystem/server/src/sync/portal-source.service.ts`：fetch 增加 `redirect: 'manual'`；3xx 明确提示检查 `PORTAL_API_BASE_URL` 与 Portal 中间件，避免把后台 HTML 当 JSON
  - `KnowledgeSystem/server/src/sync/portal-source.service.spec.ts`（新增 3 例）：缺配置、307、正常解析与 sections 扁平化
  - 本地 `.env`（均已 gitignore，不提交）：Portal 增加 `PORTAL_INTEGRATION_TOKEN=dev-shared-token`、`KS_TUTOR_BASE_URL=http://localhost:3000`、`KS_TUTOR_API_KEY=`；KS 增加 `PORTAL_API_BASE_URL=http://localhost:3011`、`PORTAL_API_TOKEN=dev-shared-token`
- **自测证据**：
  - Portal `GET /api/integration/catalogue`：带 Token **200**（返回 3 门已发布课程及课时标题）；不带 Token **401**
  - KS `npm test -- --runInBand` **14 suites / 84 tests** 通过；`npm run test:e2e -- --runInBand` **5 suites / 72 tests** 通过；`tsc --noEmit` 通过
  - Portal `tests/unit/admin-host.test.ts` **4 tests** 通过；`tsc --noEmit` 通过
- **审查结论**：未调用 test_agent（环境无该工具）；两处根因均已用真实 HTTP 探测与自动化测试验证。
- **运行环境修复**：KS 重启时报 `EADDRINUSE :::3000`，排查发现同时存在两个 `nest start --watch` watcher，旧主进程 93312 占着 3000。已停止重复 watcher（91852/81092）、旧主进程（93312/99156）和残留 watcher（74980/80772），重新启动单一 `npm run start:dev`（PID 88212）。随后按用户要求停止该后台实例（88212 及其 watcher），3000 端口已释放；当前只保留用户自己的 watcher（58616/96100）。
- **自测证据（追加）**：`/api/sync/external-courses` 返回 **200**，内容为 `epicureanism` / `stoicism` / `quintus-horatius-flaccus` 三门课程，证明 KS 已读取新 `.env` 并成功访问 Portal catalogue。
- **Git**：尚未提交
- **下一步**：在 KS 课程管理点「从 Portal 同步标题」，再配置 OpenRouter Key / Release / Online

---

## 2026-10-22 ｜ Portal「询问 AI 导师」接入 KS（课程映射 + 标题同步 + Online 隐藏入口）

- **任务（用户）**：LearningGuidePortal 课程页的「询问 AI 导师」改为通过 API 接入 KnowledgeSystem；只同步课程标题与 lesson 标题，内容暂不同步；Online 跟课程走；offline 时隐藏入口；状态要求立即生效。
- **用户拍板**：① KS 课程管理只同步课程标题 + 课时标题，正文不同步；② KS 不可达时 Portal 隐藏入口；③ Online 状态不做缓存，切换后下一次请求立即生效；④ 允许开始开发，遇问题先对接再继续。
- **变更清单**：
  - `server/prisma/schema.prisma` + `migrations/20261022120000_add_page_external_id`：新增 `Page.externalId`（Portal lesson.id，可空，复合唯一），作为标题同步稳定匹配键
  - `server/src/sync/portal-source.service.ts`（新增）：从 Portal `GET /api/integration/catalogue` 拉取已发布课程/课时标题；`PORTAL_API_BASE_URL` + `PORTAL_API_TOKEN`，服务间 `X-API-Key`
  - `server/src/sync/sync.service.ts`：改为标题同步（Course.title / Page.title / externalId 回填），正文、sectionTags、sortOrder、syncState 不动；新增 `updated` 摘要；`POST /api/sync/all` 返回 400 `CONTENT_SYNC_DISABLED`
  - `server/src/sync/sync.module.ts`、`sync.controller.ts`、`client/src/components/knowledge/SyncButtons.tsx`、`client/src/stores/knowledgeStore.ts`、`client/src/api/knowledge.ts`、`client/src/components/layout/Sidebar.tsx`：同步目标改为 Portal，按钮收敛为「从 Portal 同步标题」，失败时在侧栏显示原因
  - `server/src/ai/ai.controller.ts` + `dto/learner-chat-stream.dto.ts` + `sse-stream.ts`：新增 `POST /api/user/ai/chat-stream`；`GET /api/user/ai-tutors` 由 501 改为返回 `online` / `available`
  - `server/src/ai/ai-chat.service.ts`：抽出 `run()` 统一日志；新增 `streamLearnerChat()`（externalId 解析、Online 强制、只读 `currentReleaseId`、忽略 `aiTestReleaseId`、按 locale 注入语言指令）；删除运行时固定 SOCRATIC_GUIDE
  - `server/src/ai/ai-config.service.ts`：`listOnlineTutorsForUser()` 返回所有有 externalId 的课程及 `online` / `available`
  - `server/src/ai/ai-chat-logger.ts`：日志新增 `channel`（admin / learner）
  - `server/src/common/filters/all-exceptions.filter.ts`：允许 HttpException 携带业务 `code`（如 `CONTENT_SYNC_DISABLED`）
  - Portal：新增 `services/ksTutorClient.ts`（无缓存状态查询 + SSE 转纯文本 + 超时/断开）；`app/api/ai-tutor/route.ts` 改为 KS BFF；新增 `app/api/integration/catalogue/route.ts`；`PreviewLessonView`/`ExplorationDialog` 隐藏 offline 入口；学习页/公开课页实时读取 `available`
  - `.env.example`（两端）：新增 `KS_TUTOR_*` 与 `PORTAL_INTEGRATION_TOKEN`
  - 文档：KS 开发文档 §3.2.2/§4.2.6/§4.4.1/§4.4.2/§5.1.4/§5.2/§8；Portal `docs/phase1/api-contracts.md`
- **自测证据**：KS `npm test -- --runInBand` **13 suites / 81 tests** 通过；`npm run test:e2e -- --runInBand` **5 suites / 72 tests** 通过（含标题同步幂等、`CONTENT_SYNC_DISABLED`、学员端 Online/currentRelease/locale）；`npm run build` 通过；Portal `npx tsc --noEmit` 通过；`tests/unit/ks-tutor-client.test.ts` **5 tests** 通过；`subscribed-learning-route` + `text-preview-route` **2 tests** 通过
- **审查结论**：本轮未调用 test_agent（当前环境无该工具），改用上述单元/集成/e2e 与 typecheck 验证；Portal 组件级 offline 隐藏暂无自动化组件测试框架，留给手动验证。
- **Git**：尚未提交
- **下一步**：① Portal `.env.local` 配 `KS_TUTOR_BASE_URL=http://localhost:3000`（KS 关闭 AUTH 时 `KS_TUTOR_API_KEY` 可留空）；② 两端配同一个 `PORTAL_INTEGRATION_TOKEN` / `PORTAL_API_TOKEN`；③ KS 配 `PORTAL_API_BASE_URL=http://localhost:3011`；④ KS 课程管理同步标题后为课程配置 OpenRouter Key、创建 Release、开 Online；⑤ 用户手动验证入口显示/隐藏与流式问答

---

## 2026-10-22 ｜ AI Tutor 默认提示词替换（Lecture v1 / MixSocratic v8）

- **任务（用户）**：将 KnowledgeSystem 默认 LECTURE 与 SOCRATIC 提示词替换为 `agents/Leture_Prompt_v1.txt` 与 `agents/MixSocratic prompt_v8.txt` 的原文。
- **用户拍板**：① 移除运行时 `ai-chat.service.ts` 追加的旧固定「苏格拉底式引导者」指令（与新 MixSocratic v8「事实题可直接回答」冲突）；② 改 `prisma/seed.ts` 并执行 `npx prisma db seed`，upsert 覆盖 `lecture-default` / `socratic-default`，不影响课程级自定义；③ 允许临时停止并重启 KS 开发服务以完成 Prisma Client 生成。
- **变更清单**：
  - `server/prisma/seed.ts`：新增 `DEFAULT_LECTURE_PROMPT`（765 字符）与 `DEFAULT_SOCRATIC_PROMPT`（15716 字符），`lecture-default` / `socratic-default` 的 update/create 均引用；`welcomeMsg` 保持不变
  - `server/src/ai/ai-chat.service.ts`：删除 `SOCRATIC_GUIDE` 常量与 SOCRATIC 分支追加；保留学员侧 `LOCALE_INSTRUCTION`
  - `docs/Learning_Guide_BackOffice_Agent_Development_Document.md`：§2.1 默认模板来源改为 seed 常量并注明 2026-10-22 替换；§4.4.2 第 4 步删除固定苏格拉底注入描述
  - `server/src/ai/ai-config.service.spec.ts`：`listOnlineTutorsForUser` 用例由 501 改为实际返回断言
  - `server/test/ai.e2e-spec.ts`：SOCRATIC 用例断言改为 `not.toContain('苏格拉底式的引导者')`；`GET /api/user/ai-tutors` 改为 200 + 字段形状
  - `server/test/knowledge.e2e-spec.ts`：注入 fake `PortalSourceService`；`POST /api/sync/all` 断言 400 `CONTENT_SYNC_DISABLED`；`POST /api/sync/structure` 覆盖标题同步与幂等
- **自测证据**：源文件字符数 lecture=765 / socratic=15716，与库内 `PromptTemplate.systemPrompt` 长度一致；`npm run build` 通过；`npm test -- --runInBand` **13 suites / 78 tests** 全通过；`npm run test:e2e -- --runInBand` **5 suites / 71 tests** 全通过
- **审查结论**：首轮 Review Agent（独立新上下文）**REQUEST_CHANGES**，唯一 Blocking 为 §4.4.4 第 5 步残留「SOCRATIC 追加引导指令」与实现矛盾；已删除该描述、locale 文案对齐代码，并在 §2.1 / §4.4.2 / §4.4.4 三处统一为「不再追加固定苏格拉底指令」；复审 **APPROVE（0 Blocking）**。Non-blocking 保留：学员 `locale` 指令与 v8「跟随学生语言」硬规则的优先级未明示；无测试锁定新默认提示词内容；工作区混有 Portal 同步等上一阶段改动，提交时需拆分。
- **Git**：尚未提交
- **下一步**：用户手动在 KS 后台分别用 Lecture / Socratic 模式验证回答风格与语言规则

---

## 2026-10-22 ｜ AI Tutor 对话运行日志（文件日志方案）

- **任务（用户）**：要求「使用文件日志这个方案」为 AI Tutor 的对话质量测试提供可观测量。已确认 history 由前端 localStorage 携带、后端截最近 10 条；缺的是服务端运行日志。
- **用户拍板**：采用**文件日志**（阶段 1）——不做 DB 落库、不加会话查询接口；2026-10-14「对话不落库」决策（§4.3.2）不变。
- **变更清单（设计文档先行）**：
  - 设计文档 §4.4.2 第 7 步拆为「会话不落库 + 运行日志落文件」，写明字段、安全约束与演进预留；§4.3.2 增 2026-10-22 补充段
  - 新增 `server/src/ai/ai-chat-logger.ts`：`AiChatLogger.write()` 追加一行 JSON 到 `server/app-logs/ai-chat-YYYY-MM-DD.log`（本地时区自然日）；提问/回答压平空白后截 80 字预览、error 截 300 字；写盘失败仅 `logger.warn`
  - 修改 `server/src/ai/ai-chat.service.ts`：构造器注入 `AiChatLogger`；`streamChat()` 包 try/catch/finally，累积 answer 并判定 `ok|error|aborted`，finally 内 `void write(...).catch()` 旁路落日志；Prompt 组装与 Provider 调用逻辑零改动
  - 修改 `server/src/ai/ai.module.ts`：注册 `AiChatLogger`
  - 修改 `.gitignore`：新增 `app-logs/`
  - 新增 `server/src/ai/ai-chat-logger.spec.ts`（2 例）与 `server/src/ai/ai-chat.service.spec.ts`（4 例）
- **自测证据**：`npm run build`（nest build）退出码 0；`npm test` **13 suites / 78 tests** 全通过；`npm run test:e2e` **5 suites / 70 tests** 全通过；新增两个 spec **6 tests** 全通过
- **审查结论**：首轮 Review Agent **REQUEST_CHANGES**（唯一 Blocking：本协作日志缺失，本条目即补）。采纳 Non-blocking 2 项——`void write` 补 `.catch()` 防未来替换实现后 unhandled rejection；logger 单测改为字段集合精确匹配（多出 apiKey/baseUrl 即失败）。复审 **APPROVE（0 Blocking）**。后续项：SSE 控制器未监听 `res.on('close')`，`aborted` 分支在真实链路几乎不可达；e2e 直连真实 logger 会生成本地日志产物（已 gitignore）；error 字段未对 baseUrl/apiKey 做防御性脱敏。
- **Git**：`feature/ai-chat-log-v1` 已推送；PR https://github.com/Crescent-MJ/KnowledgeSystem/pull/8 已合并入 `main`（merge commit `49db2f9`）
- **下一步**：用户手动在 KS 后台跑几轮对话，查看 `server/app-logs/ai-chat-<日期>.log`

---

## 2026-10-20 ｜ 一键安装环境（Node 原生）＋第二仓库首次导入

- **任务（用户）**：确认「本项目是不是缺一键安装环境的功能」，要求提供「一个可读文件声明所需环境与版本 + 一键安装」，并问「是否用了本机本地环境」、提出「用 venv 作为环境库」。
- **事实澄清**：本项目为 **Node.js**（NestJS 后端 + React/Vite 前端），全仓无任何 Python 文件，**无 venv / requirements 概念**；等价物为 `package.json` + `package-lock.json`（依赖及版本锁定）。JS 依赖已就地隔离在各自 `node_modules`（隔离效果等价 venv），但 Node 运行时与 PostgreSQL 属系统级依赖。
- **用户拍板**：按 **Node 原生方式**；提供 `setup.ps1`（Windows）+ `setup.sh`（bash）+ `docker-compose.yml`（PostgreSQL）；**不引入 venv**。
- **变更清单**：
  - 新增 `.nvmrc`（`24.15.0`）；新增 `.gitattributes`（`*.sh text eol=lf`，因本仓 core.autocrlf=true）
  - 新增 `setup.ps1` / `setup.sh`：校验 Node≥22 → `npm ci`（server/client）→ 由 `.env.example` 生成 `server/.env`（不覆盖）→ 可选 `docker compose up -d postgres` → 打印后续步骤；**不写入任何密钥**
  - 新增 `docker-compose.yml`（postgres:16-alpine，默认 admin/admin/learning_guide_db，端口与凭据可用 `${VAR:-default}` 覆盖，命名卷 `lgbo_pgdata` + healthcheck）
  - 修改 `server/package.json`、`client/package.json`：新增 `engines`（node ≥22.12.0、npm ≥10）
  - 修改 `server/.env.example`：DATABASE_URL 占位串改为 `admin:admin@localhost:5432/learning_guide_db`（与 docker / 本机默认一致；README 早已公开该凭据）
  - 修改 `README.md`：新增「一键安装环境」章节；「数据库」补 Docker 选项
- **自测证据**：`setup.ps1` PowerShell 解析器 ParseFile → OK（**已加 UTF-8 BOM**，修复 PS5.1 无 BOM 按 ANSI 误读中文导致的引号失配）；空跑 `-SkipServer -SkipClient` 成功且中文输出正常；`bash -n setup.sh` exit 0、文件 0 个 CR（LF）；`docker compose config --quiet` exit 0、healthcheck 解析为 `pg_isready -U admin -d learning_guide_db`；两 `package.json` JSON 可解析；`git check-ignore server/.env` 命中 → **零密钥落盘**成立。
- **审查结论**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。Non-blocking 5 项：① 本条目此前缺失（现已补）② 脚本仅比较 Node major 而 engines 为 ≥22.12 ③ 覆盖 DB 凭据时未同步传 `POSTGRES_USER/PASSWORD/DB` 给 compose ④ README `npm install` 与脚本 `npm ci` 语义差异需一句说明 ⑤ `docs/` 两文件显示 M 但内容与 HEAD 逐字节一致（换行工件，非本次内容）。
- **Git**：工作区未提交（另含用户对 README / 开发文档 / 本日志的编辑）。
- **下一步**：已按用户裁决修复 Non-blocking ②③④——②Node 版本校验对齐 22.12（比较 major.minor）；③覆盖 DB 凭据时同步传 `POSTGRES_USER/PASSWORD/DB` 给 compose；④README 开发段补 `npm ci` / `npm install` 说明；复测通过；工作区仍未提交。
- **复审（增量）**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。仅 1 项文档一致性非阻塞（README「Node.js ≥ 22」应为 ≥ 22.12），已照改（文档笔误级，豁免门禁）。

---

## 2026-10-20 ｜ 推送记录：AI tutor V1（分支 + PR）

- **范围**：本次「攒批」全部变更一并提交推送——第六批（Releases 纯快照 / 版本删除双保护 / AI Tutor 未保存提醒）、第七批（「切换到此版本」语义收窄）、第八批（`editing` 标识下移 + 移除课程名 + editing 版本禁切换）、以及 AI Tutor 聊天用户气泡文字改白色。上述各批均已经 Review Agent 独立 APPROVE（0 Blocking）。
- **提交**：`c3fbef9` ｜ `feat(ai-tutor): AI tutor V1`
- **分支**：`feature/ai-tutor-v1`（已推送 origin，跟踪 origin/feature/ai-tutor-v1）
- **PR**：https://github.com/Crescent-MJ/KnowledgeSystem/pull/6（base: main）
- **状态**：PR 已建立，等待合并；UI 由用户手动冒烟。

---

## 2026-10-20 ｜ AI Tutor 聊天：用户气泡文字改白色（细节调整）

- **任务**（用户）：AI Tutor 的 Chat 区域，用户回答气泡背景为蓝色，**把气泡内文字改为白色**。
- **根因**：用户气泡容器已设 `color: tokens.color.bg.container`（#fff），但 `@uiw/react-md-editor` 的 `.wmde-markdown { color: var(--color-fg-default) }`（light 模式深色 #1F2328）优先级更高，白字不生效。
- **变更**：`client/src/components/ai/ChatWindow.tsx`（`Bubble` 的 Markdown 外层 `<div data-color-mode="light">` 增 `className={isUser ? 'chat-bubble-user' : undefined}`）；`client/src/index.css`（新增 `.chat-bubble-user .wmde-markdown { color: var(--color-bg-container); }`，仅作用于用户气泡，AI 气泡灰底深字不变）。未改后端/Schema/接口，无需设计文档同步。
- **自测证据**：client `npx tsc --noEmit` EXIT=0。UI/浏览器由用户手动冒烟（项目禁止 AI 浏览器操作）。
- **审查结论**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。Non-blocking 1 条（气泡内链接仍为库色 `.wmde-markdown a` #0969da，蓝底对比度偏低；按本次「文字变白」范围可接受，后续可补 `a` 覆盖）。
- **Git**：本地未提交（攒批；用户裁决先不推送）。
- **下一步**：用户手动冒烟用户气泡白字效果；如需一并处理链接色可再提。

---

## 2026-10-20 ｜ 历史版本弹窗：editing 标识下移 + 移除课程名 + editing 版本禁切换（第八批）

- **任务**（用户三项，据历史版本弹窗截图）：
  1. 弹窗标题中的 **`Population Growth`（课程名）不需要**；
  2. **`editing` 移动到下方版本名称的右侧（紧贴着）**；
  3. **如果当前是 `editing`，则不能「切换到此版本」**。
- **用户澄清裁决**（AskUserQuestion）：`editing` 判定＝**新建 Create Release 落在该新版本；若点击「切换到此版本」则落在被切换的版本**——据此新增 `Course.editingReleaseId`（当前编辑版本指针）。
- **变更清单**（设计文档先行）：
  - **设计文档**：§2（`Course` prisma 块新增 `editingReleaseId String?` + 改拍说明③）、§3.4.2（**三次改拍**：Modal 标题仅「历史版本」；`editing` 紧贴版本名右侧，标识 `Course.editingReleaseId`；标签定序 `editing`→`live`→`testing`；**editing 版本不显示「切换到此版本」**；`editing` 判定＝新建 Release / 切换到此版本；Set Live 不改；删除该版本时清空指针）、§3.4.3（Create Release 步骤增「置 `Course.editingReleaseId` = 新 Release」+ 三次改拍 note）、§3.4.5（删除时若为 editing 版本则同事务清空 `editingReleaseId`；注：editing 版本不属双保护、允许删除）、§5.1.3（GET releases 增 `isEditing`；publish/activate/delete 行补 editingReleaseId 口径）
  - **Prisma**：`schema.prisma` `Course` 加 `editingReleaseId String?`（普通标量列，无 Prisma 外键）；新增迁移 `20261020093127_add_course_editing_release_id`（`ALTER TABLE "Course" ADD COLUMN "editingReleaseId" TEXT;`，仅 ADD COLUMN）
  - **后端**：`releases.service.ts` —— `publish` 在 `release.create` 后 `tx.course.update({ data: { editingReleaseId: created.id } })`；`activate` 重建草稿后 `tx.course.update({ data: { editingReleaseId: release.id } })`；`findAllByCourse` course select 加 `editingReleaseId`、map 增 `isEditing: r.id === course.editingReleaseId`；`remove` course select 加 `editingReleaseId`，删除后若被删版本即 editing 版本则同事务置 null
  - **前端**：`api/knowledge.ts`（`ReleaseSummary` 加 `isEditing: boolean`；`ReleaseDetail` 相应 Omit/可选）、`components/knowledge/PublishPanel.tsx`（Modal 标题改为固定 `"历史版本"`，移除 `Space`/课程名/`editing` 与 `historyCourseName`；版本行 `[versionTag][isEditing→<Tag green>editing</Tag>][live][testing]`；`isEditing` 行隐藏「切换到此版本」按钮）；头注释同步
  - **测试**：`releases.service.spec.ts`（publish 断言 `course.update` 以 `editingReleaseId='r1'` 调用；activate 断言以 `editingReleaseId='r2'` 调用；findAllByCourse 增 `isEditing` 断言；remove 新增「删除 editing 版本清空指针」用例 + 普通删除断言不清指针）、`test/knowledge.e2e-spec.ts`（发布后 `isEditing=true`；activate 后 editing 落在被切换版本；新增「删除当前编辑版本清空 editing 指针」用例）
- **自测证据**：server `npm run build`（nest build）EXIT=0；client `npx tsc --noEmit` EXIT=0；server 单测 **11 suites / 72 passed**；server e2e **5 suites / 70 passed**；`npx prisma migrate dev --name add_course_editing_release_id` 已应用到本地库。UI 由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。核对确认：三需求逐条落实（标题去课程名 `PublishPanel.tsx:158`、editing 紧贴版本名 `:176-180`、editing 行隐藏切换按钮 `:185`）；editing 判定与用户裁决一致（publish/activate 两处写入、Set Live 不触碰）；`editingReleaseId` 为普通标量无外键、migration 与 schema 一致可重放；`remove` 仅在删 editing 版本时清空指针。Non-blocking 1 条（协作日志缺第八批条目——本条目即补；另 e2e 顺序耦合属既有模式）已处理
- **Git**：本地未提交（攒批；用户裁决**先不推送**）
- **下一步**：用户手动冒烟（历史弹窗标题仅「历史版本」、editing 紧贴版本名右侧、editing 版本无「切换到此版本」）；按用户裁决**本地攒批不推送**

---

## 2026-10-20 ｜ Releases「切换到此版本」语义收窄 + 历史弹窗标识调整（第七批）

- **任务**（用户三项）：
  1. **「切换到此版本」** 删掉「把 AI Tutor 上线版本切到该版本」的功能——**只能做编辑 md 中的快照切换**；
  2. 历史窗口中的 **「当前编辑版本」移到当前编辑课程名右侧并改名为 `editing`**，**删掉**「正在编辑的草稿（与已发布快照区分）」内容；
  3. **Live 版本的调整只能由 AI Tutor 板块操作**；历史窗口可展示 `testing` / `live` / `editing` 三种状态。
- **用户澄清裁决**（AskUserQuestion）：Q1 弹窗标题为「历史版本」，其后紧贴**当前编辑课程名（绿色框）+ `editing`（绿色框）**；Q2「切换到此版本」按钮**所有版本（含 Live）都显示**。
- **变更清单**（设计文档先行）：
  - **设计文档**：§3.4.2（新增 2026-10-20 二次改拍——「切换到此版本」**仅恢复快照到可编辑草稿、不改 `currentReleaseId`**；Live 指针**只能由 AI Tutor 板块 §3.4.4「Set Live」变更**；按钮对所有版本显示；Modal 标题行改为「历史版本」+ 课程名（绿框）+ `editing`（绿框）；移除「当前编辑版本」行；`aiTestReleaseId` 标识由「测试所选」改 `testing`）、§3.4.3（「不更新 currentReleaseId」补充「Live 只能由 AI Tutor Set Live 变更」）、§3.4.4（改拍：**`currentReleaseId` 只能由 AI Tutor 板块 Set Live 变更**，Knowledge 不再有改 Live 入口）、§5.1.3（activate-release 行改为「恢复历史快照到可编辑草稿，不改 currentReleaseId」）
  - **后端**：`releases.service.ts` `activate()` 删除 `tx.course.update({ currentReleaseId })`，仅保留「删现有 Page → 按 snapshotData 重建（`sortOrder`/`sectionTags` 原样、`syncState=SYNCED`）」；类注释同步
  - **前端**：`components/knowledge/PublishPanel.tsx`（`doActivate` 确认文案改为只提「覆盖当前可编辑草稿」，**不再提 AI Tutor**；「切换到此版本」按钮改为**所有版本**显示；Modal 标题改为 `Space(「历史版本」+<Tag green>课程名</Tag>+<Tag green>editing</Tag>)`；移除原「当前编辑版本」展示行；`测试所选` 标签改 `testing`；新增 `Space` 导入 + `historyCourseName`）；头注释同步
  - **测试**：`releases.service.spec.ts`（activate 用例断言 `mockTx.course.update` **未**被调用）、`test/knowledge.e2e-spec.ts`（activate-release 用例改为「先 set-live→v2 → activate releaseId → 断言草稿恢复为 releaseId 快照且 Live 仍指向 v2」）
- **自测证据**：server `npm run build` EXIT=0；client `npx tsc -b` EXIT=0；server 单测 **11 suites / 71 passed**；server e2e **5 suites / 69 passed**。UI 由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。核对确认：全仓唯一写 `currentReleaseId` 的仅 `setLive()`（AI Tutor 链路），Knowledge 板块无残留改 Live 入口；activate 重建保持 sortOrder/sectionTags/syncState；`historyCourseName` 课程未加载时回退空串安全。Non-blocking 3 条（快照 `SnapshotPage.id` 重建未复用、空快照会清空草稿、e2e 顺序耦合）均属既有设计内、无阻塞
- **Git**：本地未提交（攒批；用户裁决**先不推送**）
- **下一步**：用户手动冒烟（历史弹窗标题行课程名+editing、每版本 live/testing、切换到此版本不改 AI Tutor Live；Live 仅在 AI Tutor 用 Set Live 调整）；按用户裁决**本地攒批不推送**

---

## 2026-10-20 ｜ Releases 纯快照 + 版本删除（双保护）+ AI Tutor 未保存改动提醒（第六批）

- **任务**（用户三项）：
  1. **Knowledge → Releases**：Create Release 仅作**快照**，**不得影响 AI Tutor 的 Live 版本**；
  2. **Releases 历史版本**：每个版本后加删除 ×（**Live 状态不可删**）；「激活中」文案改为 **live**；**新增「当前编辑版本」展示行**；
  3. **AI Tutor**：修改 prompt / Welcome message / Model 后**未保存**即切换模式或其他操作会丢失改动——需新增**未保存提醒弹窗**（**保存 / 取消**两个按钮：保存＝走 Save Configuration；取消＝不保存并继续用户操作）。
- **用户裁决**（AskUserQuestion 4 项）：Q1 Create Release ＝ **纯快照 + 不自动指向**（不改 `currentReleaseId`/`aiTestReleaseId`；「切换到此版本」activate 保留现状）；Q2「当前编辑版本」＝ **仅展示标识**（不可删除、无操作按钮）；Q3 删除 ＝ **双保护**（Live 版本与后台测试所选版本都禁删）；Q4 提醒触发场景 ＝ **切换 Lecture/Socratic 模式 + 切换课程（Change Course）+ 切换 Release 版本**（**不含 New Chat**）。
- **变更清单**（设计文档先行）：
  - **设计文档**：§3.4.1（Revision Notes/Latest Release 改「最新发布快照」口径）、§3.4.2（新增「当前编辑版本」行 + live 文案 + 删除 × + 双保护）、§3.4.3（Create Release 改**纯快照、不改 `currentReleaseId`** + 「纯快照改拍影响」说明：首次发布后 Live 指针仍空，需手动选择/Set Live）、§3.4.5（**新增删除版本 Delete Release**，双保护 409）、§4.2.5（新增「未保存改动提醒」bullet）、§4.3.1（切换 Release 弹未保存提醒，引用 §4.3.6）、§4.3.2（切换模式前弹未保存提醒 bullet）、§4.3.6（**新增未保存改动提醒 Unsaved Changes Guard** 完整定义）、§5.1.3（publish 行改纯快照；新增 `DELETE /api/releases/:releaseId`；GET releases 加 `isTestSelected`）
  - **后端**：`releases.service.ts`（`publish` 删 `course.update` 改纯 `release.create`；`findAllByCourse` select 加 `aiTestReleaseId`、map 增 `isTestSelected`；**新增 `remove(releaseId)`**：事务内校验归属 → `currentReleaseId`/`aiTestReleaseId` 命中抛 `ConflictException` 409 → 否则删除）、`releases.controller.ts`（新增 `@Delete('releases/:releaseId')`）
  - **前端 Knowledge**：`api/knowledge.ts`（`ReleaseSummary` 加 `isTestSelected`；新增 `deleteRelease`；`ReleaseDetail` 调整）、`components/knowledge/PublishPanel.tsx`（Revision Notes/Latest Release 改用最新快照；历史弹窗顶部加「当前编辑版本」展示行；live 文案；`protectedVersion = isActive || isTestSelected` 时隐藏删除 ×；新增 `doDelete` 二次确认）、`components/icons.tsx`（新增 `CloseIcon`）
  - **前端 AI Tutor**：`stores/aiStore.ts`（`save()` 返回 `Promise<boolean>`）、`components/ai/useUnsavedGuard.ts`（**新建**共享 hook：无脏数据直接放行；有脏数据弹 保存/取消，保存失败中止原操作）、`components/ai/ChatWindow.tsx`（`ReleaseSelector` 与模式切换 `onModeChange` 接入 guard；移除本地 Modal）、`components/ai/ConfigPanel.tsx`（Change Course 改走 `onChangeCourse`：先 guard 再 `selectCourse`；`onSave` 按布尔返回值提示成功/失败）
  - **测试**：`releases.service.spec.ts`（publish 断言不调用 `course.update`；findAllByCourse 断言 `isActive`/`isTestSelected`；**新增 remove 4 用例**：Live 409 / 测试所选 409 / 普通删除 / 404）、`test/knowledge.e2e-spec.ts`（改纯快照断言 + 新增 set-live isActive、DELETE Live 409、DELETE 测试所选 409、DELETE 普通成功）、`test/ai.e2e-spec.ts`（夹具改「发布后显式 Set Live」；active-release + set-live 用例按纯快照重排；限流课/隔离课补 set-live/active-release 前置）
- **自测证据**：server `npm run build` EXIT=0；client `npx tsc -b` EXIT=0；server 单测 **11 suites / 71 tests passed**；server e2e **5 suites / 69 tests passed**。UI 外观/交互由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。Non-blocking 4 条：① 本文档缺第六批条目（**本条目即补齐**）；② `PublishPanel.tsx` 头注释仍写「激活中/发布即激活」（**已同步修正**）；③ `useUnsavedGuard` 保存失败仅经 `aiStore.error`（ChatWindow Alert）呈现，未按 §4.3.6 显式 toast（属可选增强）；④ `onChangeCourse`/`onModeChange` 对 `selectCourse`/`setMode` 无 try/catch（沿袭既有模式，非本期引入）
- **审查后续（2026-10-20 用户裁决「③④＋第五批遗留 saveConfig 空串语义 全部修复」）**：②③④ 已修 + ⑤ 第五批遗留 `saveConfig` 空串语义一并修复——`ai-config.service.ts` 改 `dto.systemPrompt || null`/`dto.welcomeMsg || null`（空串归一 null，对齐 §5.2 契约）；`useUnsavedGuard.ts` 保存失败改为显式 `message.error(...)` 后再 `resolve(ok)`；`aiStore.ts` 的 `selectCourse`/`setMode` 包 try/catch（异常写 `error` 状态、不抛，避免未捕获 rejection）。**复核（同一 Review Agent 续审）结论 APPROVE（0 Blocking，0 Non-blocking）**；复核证据：server build EXIT=0、client tsc EXIT=0、单测 **71/71**、e2e **69/69**（⑤ 对标 `|| null` 无 `''` 断言、无回归）
- **Git**：本地未提交（攒批；用户裁决**先不推送**）
- **下一步**：用户手动冒烟（Create Release 不影响 AI Tutor Live；历史弹窗「当前编辑版本」/live/删除 ×（Live 不可删）；改配置未保存时切换模式/课程/Release 弹 保存-取消）；按用户裁决**本地攒批不推送**

---

## 2026-10-20 ｜ AI Tutor 配置（System Prompt / Welcome / LLM Model）按模式（Lecture / Socratic）分开保存

- **任务**（用户报告缺陷）：设置成 Live 之后点击 Lecture/Socratic 切换**无任何反应**；用户判断是 **Save Configuration** 的问题——一旦改动并 Save，切换模式就不再载入对应的 prompt / welcome / model。用户澄清：**Live 只是发布指令**（把当前版本推送到用户侧），**不影响后台测试**。
- **根因**（已读码定位）：自定义配置 `customSystemPrompt / customWelcomeMsg / llmModel` 为**单一字段**（不区分模式），Save 后对两种模式同时生效，故切换模式来看「无变化」；Set Live 不改表单，故「Set Live 后无反应」同属该根因。
- **用户裁决**（AskUserQuestion 3 项）：① System Prompt + Welcome Message = **按模式分别保存**；② LLM Model = **也按模式分开**；③ 存量单份自定义配置 = **回填到两个模式**。
- **变更清单**（设计文档先行）：
  - **设计文档**：§2 CourseAiConfig 拆为 `lectureSystemPrompt/socraticSystemPrompt/lectureWelcomeMsg/socraticWelcomeMsg`（String? @db.Text）+ `lectureModel/socraticModel`（String?，null 回退 AI_AVAILABLE_MODELS[0]）+ 共享 `llmProvider/llmBaseUrl/apiKey`，删 `customSystemPrompt/customWelcomeMsg/llmModel`；§4.2.1/§4.2.2「按模式分开保存」bullet；§4.2.3 按模式 + 回退默认；§4.2.4 Reset 改「重置当前所选模式」+ 接口带 mode；§4.2.5 Save 加 mode；§4.3.2 模式切换改为三者均自动更新；§5.2 新增「二次改拍」blockquote + `AiConfigView` 按模式分组 JSON + `PUT config` body 带 mode + 接口表更新（reset 带 `{ mode }`）
  - **Prisma**：`schema.prisma`（CourseAiConfig 改按模式字段）；前向迁移 `server/prisma/migrations/20261020130000_ai_config_per_mode/migration.sql`（新增 6 列 TEXT 可空 → `UPDATE ... SET lectureSystemPrompt=customSystemPrompt, socraticSystemPrompt=customSystemPrompt, lectureWelcomeMsg=customWelcomeMsg, socraticWelcomeMsg=customWelcomeMsg, lectureModel=llmModel, socraticModel=llmModel` → DROP 三旧列），已 `migrate deploy` 成功
  - **后端**：`ai-config.service.ts`（`AiConfigView` 改为 `{ courseId, releaseId, releaseTag, isLive, llmProvider, online, hasApiKey, lecture, socratic }`，新增 `AiModeView`；`saveConfig` 按 `dto.mode` 只写该模式三列；`resetConfig(courseId, mode)` 只重置当前模式；`resolvePrompts` 按模式取自定义；`resolveRuntime(courseId, releaseId, mode)` 按模式取模型；`toView` 分组返回）、`dto/save-config.dto.ts`（新增 `mode`、字段改名 `systemPrompt/welcomeMsg`）、`dto/reset-config.dto.ts`（新增，`{ mode }`）、`ai.controller.ts`（reset 带 body mode）、`ai-chat.service.ts`（`resolveRuntime` 传 `dto.mode`）
  - **前端**：`api/ai.ts`（`AiConfigView` 改为 lecture/socratic 分组；`saveConfig` 带 mode；`resetConfig(courseId, mode)`）、`stores/aiStore.ts`（新增 `buildForm` 按模式取 自定义>模板 + 该模式 model；`setMode` 三者均载入对应模式值；`save` 带 mode；`reset` 带 mode；`selectRelease` 按模式）、`components/ai/ConfigPanel.tsx`（Reset 提示文案改为「当前模式」）
  - **测试**：`ai-config.service.spec.ts`（新增 saveConfig 按模式、SOCRATIC 只写 socratic、resetConfig 只清当前模式、resolvePrompts 按模式、resolveRuntime 按模式等用例；mock 补 `promptTemplate`）、`ai.e2e-spec.ts`（config/加密/reset/限流/Release 隔离用例改为按模式口径 + 新增「AI 配置按模式隔离：保存/重置只影响当前模式」）
- **自测证据**：server `npx tsc --noEmit` 0 错；client `npx tsc --noEmit` 0 错；server 单测 **11 suites / 67 tests passed**；server e2e **5 suites / 65 tests passed**；`prisma migrate status` up to date 无 drift（由 Review Agent 复跑确认）。UI 外观/交互由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。Non-blocking 3 条：① 【AI协作日志】缺第五批条目（本条目即补齐）；② `saveConfig` 空串经 `?? null` 仍存 `''`，视图返回 `''` 而非 §5.2 所称 `null`（前端 `||` 回退下行为一致，仅契约语义不严格，建议改 `dto.systemPrompt || null`）；③ `setMode` 会静默丢弃未保存改动（§4.3.2 未要求弹确认）。②③ 待用户裁决
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：用户手动冒烟（切换 Lecture/Socratic 应分别载入各自 prompt/welcome/model；Save 后仍可切换；Set Live 不影响测试）；②③ 是否修待用户裁决；按用户裁决继续本地攒批不推送

---

## 2026-10-20 ｜ AI Tutor 知识库 Release 选择器 + Set Live + AI 配置改按 Release 维度保存

- **任务**（用户）：AI Tutor 对话头部（Lecture/Socratic 按钮左侧）原**只读显示当前知识库 Release**，改为**可点击的 Release 选择器**（按发布时间**倒序**）；旁边加 **Set Live**（把某 Release 设为**上线版本**）。同时 **AI 配置（知识库 / system prompt / welcome message / LLM model / apiKey）改为按 Release 维度保存**——切换 Release 时加载该 Release 用 Save Configuration 存过的配置。Online 开关保持课程级。
- **用户裁决**（AskUserQuestion 三轮 8 项 + 徽章澄清）：
  1. AI 配置保存维度 = **每个 Release 一份**；2. Set Live = **轻量：仅切换 Live 指针**（不重建草稿）；3. 「当前测试所选 Release」= **后端每课程持久化**；4. 新建 Release 的 AI 配置来源 = **模板默认**；
  5. 切 Release 时有未保存改动 = **提示 保存 / 丢弃**；6. Online 作用域 = **保持课程级**；7. Release 下拉**不含「当前编辑草稿（未发布）」**；8. 徽章：AI Tutor 顶部栏右侧静态 Testing **移除**，改挂 **versionTag 旁**并**动态 Testing/Live**；用户澄清规则：**所选 Release = 上线版本 ⇒ 显示 live**（下拉列表中该版本旁也标 live）；**选择其他版本均为 testing**；**testing 状态点 Set Live ⇒ 该版本变 live、徽章变 live**。
- **变更清单**（设计文档先行）：
  - **设计文档**：§2 Course（+`aiTestReleaseId`/`aiTutorOnline`、`aiConfig`→`aiConfigs[]`）/ Release（+`aiConfigs[]`）/ CourseAiConfig（+`releaseId`、去 `courseId @unique`/`online`、`@@unique([courseId,releaseId])`、`onDelete: Cascade`）；§3.1 顶部栏徽章移除；§3.4.4 **新增 Set Live（轻量）**；§4.1 顶部栏移除 Testing、右列改 Release 选择器+Set Live；§4.2.5 按 Release 维度改拍；§4.2.6 online 改 Course 课程级；§4.3.1 对话头部 Release 选择器+Set Live+动态徽章+dirty 弹确认；§4.3.4 对话流程（读 `aiTestReleaseId ?? currentReleaseId`）；§4.4.2 核心处理；§5.1.3 新增 set-live 行；§5.2 新增 active-release 接口 + 按 Release 注记 + 无 Release 边界
  - **Prisma**：`server/prisma/schema.prisma`；前向迁移 `server/prisma/migrations/20261020120000_ai_config_per_release/migration.sql`（Course 加两列；`UPDATE Course SET aiTutorOnline=cfg.online WHERE online=true`；CourseAiConfig 加 releaseId 先可空→回填=currentReleaseId→删 NULL 行→SET NOT NULL→DROP online→DROP 旧 unique→建复合 unique→加 FK ON DELETE CASCADE），已 `migrate deploy` 成功
  - **后端**：`ai-config.service.ts`（整体重写，新增 `releaseId/releaseTag/isLive`、`testReleaseIdOf`、`requireReleaseId`、`setActiveRelease`、`setOnline`→Course、`resolvePrompts/resolveRuntime` 带 releaseId、`toView` 等式判 live）、`dto/set-active-release.dto.ts`、`ai.controller.ts`（新增 `PUT config/:courseId/active-release`）、`ai-chat.service.ts`（带 `aiTestReleaseId`→releaseId）、`releases.service.ts`+`controller.ts`（新增轻量 `setLive` + `POST /courses/:id/set-live`）
  - **前端**：`api/ai.ts`（加 releaseId/releaseTag/isLive + `setActiveRelease`）、`api/knowledge.ts`（加 `setLive`）、`stores/aiStore.ts`（新增 `releases`/`selectRelease`/`setLive`；`selectCourse` 并发拉 config+releases）、`ChatWindow.tsx`（新增 `StateBadge`+`ReleaseSelector`：倒序下拉+Live Tag+当前项高亮、Set Live 按钮、dirty 弹确认）、`AITutor.tsx`（移除顶部栏 TestingBadge）
  - **测试**：`ai-config.service.spec.ts`（重写，11 用例）、`ai.e2e-spec.ts`（config GET 断言 releaseId/isLive、online 读 Course、新增 active-release + set-live 用例）
- **自测证据**：server `npx tsc --noEmit` 0 错；client `npx tsc -b --force` 0 错；server 单测 **11 suites / 62 tests passed**；server e2e **5 suites / 63 tests passed**（含修复：限流用例须**先发布 Release 再保存配置**，因配置改按 Release 维度后无 Release 会 400）；`npx prisma migrate status` → **up to date 无 drift**。UI 外观由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE（0 Blocking）**。Non-blocking 6 条：① 第四批【AI协作日志】缺失（本条目即补齐）；② `setLive` 未包 `$transaction`，与 §3.4.4 第 3 步「单事务内」措辞不符；③ `set-live` 复用 `ActivateReleaseDto`（无 `@IsUUID`），非法 UUID 走 404 与 active-release 的 400 不一致；④ 「切换 Release 加载对应配置」缺专项隔离测试（A→B→A 回显）；⑤ `aiTestReleaseId`/`currentReleaseId` 为无 FK 标量（沿袭既有模式）；⑥ 预留钩子 501 经全局过滤器映射 `INTERNAL_ERROR`（既有批 3 遗留，建议增 `NOT_IMPLEMENTED` 映射）
- **审查后续（2026-10-20 用户裁决「全部修复」）**：② `setLive` 改为 `$transaction` 单事务（对齐 §3.4.4）；③ `ActivateReleaseDto` 加 `@IsUUID()`（与 `SetActiveReleaseDto` 口径一致，set-live 非法 UUID → 400）；④ 补 e2e「AI 配置按 Release 维度隔离」（R1 存自定义 → 切 R2 回退默认 → 切回 R1 回显）。⑤⑥ 保留为遗留项。**复核（同一 Review Agent 续审）结论 APPROVE（0 Blocking）**；其指出 `aiStore.ts` / `ChatWindow.tsx` 两处注释仍引用旧编号 → **已同步改为 §4.3.5**。复核证据：server tsc 0 错、单测 62/62、e2e **64/64**、client tsc 0 错
- **设计偏差上报**：文档重复章节号 **§4.3.4**（第 518 行「对话流程」与 533 行「对话消息格式」冲突）——**2026-10-20 用户裁决修正**：后段「对话消息格式」改编号为 **§4.3.5**（文档无其他引用）
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：用户手动冒烟（Release 选择器倒序 / 切换加载配置 / Set Live 后徽章变 live / dirty 弹确认）；按用户裁决继续**本地攒批不推送**；⑤⑥ 保留为遗留项

---

## 2026-10-20 ｜ AI Tutor 顶部栏标题与配置卡标题对调（「AI Tutor 配置」→「AI Tutor」）

- **任务**（用户）：将「AI Tutor 配置」改名为「AI Tutor」，并把该名称与当前位于其上方（顶部栏）的 **Course 名对调位置**。
- **用户裁决**（AskUserQuestion，2 项）：① 对调后 **顶部栏显示「AI Tutor」**、**配置卡标题行显示当前 Course 名**（其后仍保留 Online 开关 + Change Course 下拉）；② 顶部栏静态 **「Testing」徽章保留**。
- **变更清单**：
  - **设计文档**（先改后实现）：§4.1 顶部栏标题改为模块名「AI Tutor」、左列卡片标题行左侧改为「当前 Course 名」；新增注记「2026-10-20 顶部栏标题与配置卡标题对调」；§3.1 注记②改为「AI Tutor 顶部栏（模块名）」、③改为「与 Course 名同一行」、**新增⑤对调说明**；§4.2.6 开关位置描述改为「Course 名右侧紧贴处」；§2 schema 注释更新
  - **`client/src/pages/AITutor.tsx`**：`AITutorTopBar` 标题由「当前 Course 名」改为静态 「AI Tutor」（样式不变：全宽白栏/高 63/底边线/主色 `#145CFF`/16px/600/底部 2px 下划线），保留 `TestingBadge`；移除不再需要的 `courses`/`selectedCourseId` 读取与过期注释
  - **`client/src/components/ai/ConfigPanel.tsx`**：卡片标题行左侧由「AI Tutor 配置」改为**当前 Course 名**（新增派生 `courseName = courses.find(...)?.title ?? '—'`，span 加 `title` 属性便于截断查看）；同步更新组件头注释与标题行注释
- **自测证据**：client `npx tsc --noEmit` 0 错、`npm run build`（tsc -b && vite build）**✓ built in 1.26s**（仅既有 chunk 体积告警）。UI 外观由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，3 Non-blocking）：① `ConfigPanel` 标题行注释仍写旧文案 → **已按建议修正**；② `AITutor` 页面注释「顶部课程标题栏」措辞过期 → **已修正为「顶部模块标题栏」**；③ 提示 Change Course 下拉始终显示课程名、与左侧 courseName 略重复（系对调前既有模式平移，属用户已确认口径，非缺陷）。评审实测复核：`tsc --noEmit` 0 错、`build` ✓ 1.15s、确认 `courseName` 边界（空列表/未选课回退 `—`）、无未使用导入（noUnusedLocals）、与 §4.1/§3.1/§4.2.6 一致
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：用户手动冒烟（顶部栏显示「AI Tutor」+ Testing 徽章；配置卡标题行显示当前 Course 名）；待用户确认后再推送

---

## 2026-10-20 ｜ AI Tutor 对话头部控件样式（Lecture/Socratic 胶囊切换 + New Chat 主色主按钮）

- **任务**（用户按上传参考图）：① 将 Lecture / Socratic 模式切换按钮改为图片样式；② 旁边 New Chat 按钮样式同步按图片调整。
- **参考图规格**：模式切换＝**胶囊型分段控件**（整条主色描边 + 白底 + 全圆角），选中项实心主色底白字、未选中项白底主色字；New Chat＝**主色实心主按钮** + 前置「+」图标 + 白色加粗文字。
- **变更清单**：
  - **设计文档**（先改后实现）：§4.3.1 新增注记「2026-10-20 对话头部控件样式调整」（模式切换胶囊样式 + New Chat 主色实心主按钮规格）
  - **`client/src/index.css`**：`.ai-mode-segmented` 由「仅选中项蓝底」扩展为胶囊型——整体 `1px var(--color-primary)` 描边 + `var(--color-bg-container)` 白底 + `border-radius:999px`；`.ant-segmented-item` 设 `border-radius:999px` / 主色字 / `font-weight:600`；未选中 hover 底 `--color-primary-bg` 且文本保持主色（`!important` 覆盖 AntD 更高特异性的 hover 文本色规则）；选中项实心主色底白字；`.ant-segmented-thumb` 主色 + 圆角 999
  - **`client/src/components/ai/ChatWindow.tsx`**：New Chat 由 `size="small"` 次级按钮改为 `type="primary"` 主色实心按钮 + `PlusOutlined` 图标 + `fontWeight: tokens.fontWeight.semibold`
  - **样式复用既有 CSS 变量**（`--color-primary` / `--color-bg-container` / `--color-primary-bg`），未新增硬编码色值
- **自测证据**：client `npm run build`（tsc -b && vite build）**✓ built in 1.19s**（仅既有 chunk 体积告警）；Grep 确认 `.ai-mode-segmented` 全仓库仅出现在 `index.css` 与 `ChatWindow.tsx`，无回归引用；`onChange`/`onClick={newChat}` 未改动（无行为变更）。UI 外观由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，3 Non-blocking + 1 设计偏差上报）：① hover 时未选中项文本会被 AntD 更高特异性 hover 规则压成近黑 → **已按评审建议当场修复**（补 `color: var(--color-primary) !important`）；② 工作区另含上一批 Schema/后端/新组件变更，未纳入本次审查（属既有待合并变更集）；③ index.css 中 `font-weight:600` 与 tokens 重复（既有风格）；**设计偏差上报**：文档存在重复章节号 §4.3.4（第 487 / 502 行，既有问题，非本次引入），建议其一改为 §4.3.5。评审实测复核：client `tsc --noEmit` 0 错、`npm run build` ✓ 1.15s，并核验 CSS 选择器精确命中 AntD 5.29 DOM、样式已入构建产物
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：用户手动冒烟（胶囊切换按钮静态态与 hover 态 / New Chat 主色主按钮）；待用户确认后再推送

---

## 2026-10-20 ｜ AI Tutor 配置区加宽（40/60）+ Online 开关 + 「管理所有 online」弹窗

- **任务**（用户 3 项要求）：① 加宽左侧 AI Tutor 配置卡片，与右侧 chat 重新分配区域（配置 40% / chat 60%）；② 在「AI Tutor 配置」字样右侧紧贴处增加一个 Switch，开关左侧写 `Online`，作用是控制该配置是否对用户侧开放（预留对应接口）；③ 在 Change Course 下拉面板最下侧增加链接「管理所有 online」，点击弹出表格弹窗——罗列全部 online 与未 online 的 AI Tutor，可按名称 / Online 状态排序、支持按名称搜索。
- **用户裁决**（AskUserQuestion，4 项）：① Online 状态存储＝**`CourseAiConfig.online`（Boolean，默认 false）**；② 保存方式＝**切换即时生效（新增独立接口）**；③ 管理弹窗＝**表格内每行可切换（点即改即存）**；④「预留对应的接口」＝**仅预留路由 / Service 钩子，不实现业务逻辑**。
- **变更清单**：
  - **设计文档**（先改后实现）：§2 `CourseAiConfig` 新增 `online Boolean @default(false)`；§5.2 新增 `PUT /api/ai/config/:courseId/online`、`GET /api/ai/tutors`、`GET /api/user/ai-tutors`（预留钩子）三行，并在 `GET /api/ai/config/:courseId` 行注明含 `online`；§4.1 左右分栏改为 40%/60%（新增改拍注记）；新增 **§4.2.6 Online 开关与管理弹窗**（开关即时生效、管理弹窗列/排序/搜索均前端本地、预留接口口径）
  - **Prisma**：`server/prisma/schema.prisma` 加 `online Boolean @default(false)`；迁移 `20261020032026_add_course_ai_config_online`（`ALTER TABLE "CourseAiConfig" ADD COLUMN "online" BOOLEAN NOT NULL DEFAULT false;`）已创建并应用
  - **后端 service** `ai/ai-config.service.ts`：`AiConfigView` 加 `online`；新增 `AiTutorListView`；新增 `setOnline(courseId, online)`（upsert 即时生效）、`listTutors()`（全课程 + online 状态，无记录视为 false）、`listOnlineTutorsForUser()`（**抛 NotImplementedException 501，预留**）；`toView` 返回值加 `online`
  - **后端 DTO** 新增 `ai/dto/set-online.dto.ts`（`@IsBoolean() online!`）
  - **后端 controller** `ai/ai.controller.ts`：`AiController` 新增 `PUT config/:courseId/online`、`GET tutors`；文件末尾新增 `@Controller('user')` 的 `UserAiController`（`GET ai-tutors` → 预留钩子）；`ai.module.ts` controllers 加入 `UserAiController`
  - **前端 api** `client/src/api/ai.ts`：`AiConfigView` 加 `online`；新增 `AiTutorListView`、`aiApi.setOnline`、`aiApi.listTutors`
  - **前端 store** `client/src/stores/aiStore.ts`：新增 state `tutorManagerOpen` / `tutors` / `tutorsLoading`；新增 action `setOnline`（当前课程即时切换，并同步弹窗行）、`setTutorOnline`（行内切换，若为当前课程回收卡片 `config.online`）、`openTutorManager` / `closeTutorManager`
  - **前端布局** `client/src/pages/AITutor.tsx`：左列 `flex:'0 0 40%'`、右列 `flex:'1 1 0'`（60%）；挂载 `<TutorManagerModal />`
  - **前端卡片** `client/src/components/ai/ConfigPanel.tsx`：标题行左「AI Tutor 配置」+ 紧贴的 `Online` 文案 + `Switch`（`checked=config?.online`、即时 `onOnlineChange`）；Change Course `Select` 受控 `open` + `popupRender` 面板底部追加 `Divider` + 「管理所有 online」下划线链接（点击收起下拉并打开弹窗）
  - **前端新增组件** `client/src/components/ai/TutorManagerModal.tsx`：Modal（标题「管理所有 online」）+ 右上角 `Input.Search`（按名称过滤）+ `Table`（列 `AI Tutor` 按名称 `localeCompare` 排序、列 `Online` 按布尔排序、行内 `Switch` 点即改即存）
  - **UI 出口** `client/src/components/ui/index.ts`：透传新增 `Switch` / `Divider`
- **自测证据**：server `npx tsc --noEmit` **EXIT=0**；client `npx tsc --noEmit` **EXIT=0**、`npm run build`（tsc -b && vite build）**✓ built in 1.20s**；server 单测 `npx jest` **11 suites / 56 tests passed**（新增 `ai-config.service.spec.ts` 4 例）；server e2e `npx jest --config ./test/jest-e2e.json` **5 suites / 62 tests passed**（新增 5 例：online 切换即时生效、非布尔 400、tutors 列表、user 侧 501）。UI 由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，4 Non-blocking）：① 501 走全局过滤器 default 分支映射为 `INTERNAL_ERROR`（信封格式一致、非阻塞；建议增设 `NOT_IMPLEMENTED` 映射）；② `AITutor.tsx` 中 `#ECFDF3` / `height:63` 沿袭既有硬编码未走 token（极小）；③ 文档 §4.1 措辞「左列保留最小宽度兜底」与实现 `flex:'0 0 40%'` 略有不符 → **已回填文档为「40% 固定占比、不收缩」**；④ `UserAiController` 与 `AiController` 同文件（预留阶段可接受）。评审实测复核：server tsc 0 错、单测 56/56、e2e 62/62、`prisma migrate status` 无 drift；client tsc 0 错、build ✓ 1.31s；并确认 `antd@5.29.3` Select 类型含 `popupRender`、`.env` 未入库
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：用户手动冒烟（40/60 分栏 / Online 开关即时生效 / 下拉底部「管理所有 online」链接 / 弹窗排序与搜索 / 行内切换并回写卡片开关）；待用户确认后再推送

---

## 2026-10-20 ｜ AI Tutor 布局调整（导航列白底铺满 / Change Course 移入配置卡 / 课程标题栏对齐 Knowledge Tab 栏 / 底栏脱离卡片）

- **任务**（用户 4 项要求）：① 最左侧模块导航列下方露出灰底，整列应统一白底；② course 选择器移到「AI Tutor 配置」右侧同一行；③ 课程标题行按图 1 展示（蓝色加粗下划线）+ 右侧紧贴静态 Testing 徽章；④ Reset / Save Configuration 按图 2 调整位置与样式。
- **用户裁决**（AskUserQuestion）：① 下拉位置＝**放进「AI Tutor 配置」卡片标题行右侧**（标题左、下拉右，同一行）；② 标题样式＝**主色蓝加粗 + 文字下方蓝色下划线（与图 1 一致）**；③ Testing＝**固定展示的静态徽章（始终显示，纯装饰）**；④ 底栏＝**去掉顶部分隔线**，Reset 左 / Unsaved changes & Save 右（与图 2 一致），Reset 为蓝色下划线文字链接。
- **根因（①）**：`ModuleNav` 的 `<nav>` 仅按内容高度渲染，其容器 `div` 亦无高度，下方露出 `Layout` 灰底 `#F8FAFC`。
- **变更清单**：
  - **设计文档**（先改后实现）：§4.1 页面布局改为「顶部课程标题（主色蓝加粗+下划线）+ 静态 Testing 徽章」「Change Course 移入配置面板卡片标题行右侧」；§4.2.5 底栏说明改为「去掉顶部分隔线、Reset 为蓝色下划线文字链接」；§3.1 新增注记「2026-10-20 模块导航列白底铺满 + AI Tutor 布局调整」（①–④）
  - **`layout/ModuleNav.tsx`**：`<nav>` 增 `height: '100%'`（白底 `bg.container` 铺满整列）
  - **`layout/MainLayout.tsx`**：导航列外层宽度容器 `div` 增 `height: '100%'`
  - **`pages/AITutor.tsx`**（第一轮，第二轮已重写，见下）：移除顶部栏的 `Select`/`selectCourse`/`Typography`；课程标题行改为 `<span>`（`fontSize 20`/`fontWeight bold`/`color primary #1D6BFF`/`paddingBottom 6` + `borderBottom 2px primary`，下划线宽度=文字宽度），右侧紧跟新增本地组件 `TestingBadge`（浅绿底 `#ECFDF3` + 6px 绿点 + 绿字 `success`，圆角 999，静态）
  - **`ai/ConfigPanel.tsx`**（第一轮，第二轮已重写，见下）：Card `title` 改为标题行节点——左「AI Tutor 配置」（超长省略号）、右 `Change Course` `Select`（`size="small"`、`flexShrink:0`、`minWidth 150`，值/回调接自 store `courses/selectedCourseId/selectCourse`）；底部操作栏移除 `borderTop`，`Reset` 改为 `Button type="link"` 内嵌 `textDecoration: underline` span，`Space` 间距改 `spacing.lg`
- **自测证据**：前端 `npx tsc -b --noEmit` **TSC_EXIT=0**（0 错误）；`npx vite build` **✓ built in 1.37s**（仅既有 chunk 体积告警）。UI 外观按项目约束由用户手动冒烟
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，3 Non-blocking）：① `server/e2e_out.txt` 为未跟踪调试产物，建议清理/加 `.gitignore`（本次范围外）；② Card head-title 默认 `nowrap/overflow:hidden`，超长课程名可能挤压下拉——**已当场采纳修复**（标题 span 加 ellipsis、Select 加 `flexShrink:0`）；③ 协作日志未回填——**本次已补录**。评审实测复核：client `tsc -b --noEmit` EXIT=0；`lint` 0 errors（4 warnings 均在既有文件）
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **第二轮（同日追加裁决）**：用户要求 ③ 课程标题行的**展示方式与 Knowledge 顶部 Tab 栏（Knowledge Pages / Releases）保持一致**；④ 底部操作栏**脱离配置卡片**、置于卡片下方（卡片下边界上移至 LLM Model 功能区下方、不再包裹操作栏，纵向下移卡片、操作栏位置不变）；并同意清理 `server/e2e_out.txt` 调试残留。
- **第二轮变更清单**：
  - **设计文档**：§3.1 注记 ②/④ 与 §4.1/§4.2.5 改写为上述口径
  - **`pages/AITutor.tsx`**：新增导出组件 `AITutorTopBar`——与 `KnowledgeTabBar` 同规格（高 63 / 内边距 `0 24` / 白底 `bg.container` / 底边线 1px `border`；标题 `fontSize['2xl']`(16) / `semibold`(600) / `primaryDark #145CFF` + 绝对定位 2px 下划线，宽度=文字宽度）；右侧静态 `TestingBadge`（浅绿底 `#ECFDF3` + 绿点 + 绿字）。页面主体仅 `[配置面板 | 对话窗口]`，根节点改 `height:'100%'`（新增 63px topBar 后原 `calc(100vh - 140px)` 不再适用）
  - **`App.tsx`**：`ai-tutor` 模块经 `topBar` 注入 `<AITutorTopBar />`
  - **`ai/ConfigPanel.tsx`**：根节点改 flex 列（`height:100%`）——Card `flex:1/minHeight:0`（下边界止于 LLM Model 下方），**操作栏移出卡片**为下方独立区块（`flexShrink:0`，`padding 0 4px`）
  - **清理 `server/e2e_out.txt`**（`git ls-files` 无记录、未被任何 npm script 引用，用户同意）
- **第二轮自测**：client `npx tsc -b --noEmit` **TSC_EXIT=0**；`npx vite build` **✓ built in 1.03s**
- **第二轮审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，3 Non-blocking）：① 本日志条目停留在第一轮实现 → **已按最终实现重写本条**；② 340px 列下 dirty 态操作栏三点偏挤，冒烟时留意换行（较原先置于卡片内更宽松，属改善）；③ `TestingBadge` 背景 `#ECFDF3` 硬编码未走 token（极小）。评审逐值比对 `KnowledgeTabBar.tsx` 确认高度 / 内边距 / 底边线 / 颜色 / 字号 / 字重 / 下划线**全部一致**
- **下一步**：用户手动冒烟（最左列白底 / 配置卡标题行下拉 / AI Tutor 顶栏与 Knowledge Tab 栏一致 / Testing 徽章 / 底栏脱离卡片且 Reset 为下划线链接）

---

## 2026-10-19 ｜ 内容面板样式统一（Knowledge Pages / Releases / AI Tutor 三区对齐 Figma）

- **任务**：用户要求结合 Figma 设计缓存（`figma/tools/design-cache/YL-KS+AI_UIIFinal-20261019-105235`）中的「1 knowledge」与「2 Ai tutor 配置」，将 Knowledge 与 AI Tutor 的**页面内容框格式统一**，**不增删内容，仅做内容框外观设计**。
- **用户裁决**（AskUserQuestion）：① 统一口径 = **完全按 Figma**（主面板 白/圆角12/无边框/卡片阴影；子块圆角8；输入类 1px #E2E8F0 + 底 #FAFBFC）；② 覆盖范围 = **三个内容区全统一**（Knowledge Pages、Knowledge Releases、AI Tutor 两面板）。
- **Figma 规格提炼**（经子代理读取 3.8MB 导出 JSON）：主面板 `#FFFFFF` / 圆角 `12` / 无边框 / 阴影 `0 1px 2px -1px rgba(0,0,0,.1), 0 1px 3px rgba(0,0,0,.1)`；子块圆角 `8`；输入类 `1px #E2E8F0` + 底色 `#FAFBFC`；标签药丸圆角 `999`；页面底色 `#F7FAFC`。两内容页容器材质一致，尺寸因布局不同。
- **变更清单**：
  - **设计文档**（先改后实现）：§3.1 新增注记「2026-10-19 内容面板样式统一（对齐 Figma 1 Knowledge / 2 AI Tutor）」，含主面板 / 子块 / 输入类三段规格；并修复被覆盖的「2026-10-16 扁平化改拍」行
  - **新增 `ui/Panel.tsx`**：内容面板统一外壳——`background: bg.container`(白) / `borderRadius: radius.lg`(12) / `border:none` / `boxShadow: shadow.card`，`padding` 默认 `spacing.lg`(16)（可传 0 关闭）
  - **`ui/index.ts`**：导出 `Panel` / `PanelProps`
  - **`ui/Card.tsx`**：默认 `variant="borderless"` + `boxShadow: tokens.shadow.card`（圆角 12 由主题 `borderRadiusLG` 提供）——使 AI Tutor 使用 Card 的两面板自动与 Knowledge 的 `Panel` 外观统一
  - **`theme/tokens.ts`**：新增输入语义色 `color.inputBorder`(`#E2E8F0`) / `color.inputBg`(`#FAFBFC`)
  - **`App.tsx`**：ConfigProvider 主题新增 `borderRadiusLG: tokens.radius.lg`(12)，并新增 `components.Input` / `components.Select` 覆盖——描边 `#E2E8F0`、底色 `#FAFBFC`（落实口径「输入类 1px #E2E8F0 + 底 #FAFBFC」）
  - **`knowledge/PageEditor.tsx`**：根节点 `<div>` → `<Panel style={{display:'flex',flexDirection:'column'}}>`（新导入 Panel）；正文内框圆角 `radius.sm`(6) → `radius.md`(8) 对齐 Figma 子块；**空状态修正**——未选中页面时原提前 `return <Empty style={{marginTop:120}}>` 裸渲染（无面板），现补齐套 `Panel` 并居中（`alignItems/justifyContent:center`），使内容区**任何状态**都显示白面板
  - **`knowledge/PublishPanel.tsx`**：根节点 `<div>` → `<Panel style={{overflow:'auto'}}>`（新导入 Panel）
  - AI Tutor `ConfigPanel.tsx` / `ChatWindow.tsx`：**无需改动**（依赖 `ui/Card` borderless+shadow、主题圆角 12 与输入类 components 覆盖自动生效）
  - **左侧课程树列卡片化（用户追加）**：`layout/MainLayout.tsx` 的 `Sider` 去掉右边框、底色改页面灰底 `bg.layout`、加内边距 `spacing.lg`（与 Content 对称）；`layout/Sidebar.tsx` 根节点 `<div>`（原 `padding: spacing.md`）→ `<Panel style={{display:'flex',flexDirection:'column'}}>`（新导入 Panel），使「同步目标 / 课程树 / Sync 按钮」整列在灰底上悬浮为白色圆角卡片
- **自测证据**：前端 `npx tsc --noEmit` 0 错误；`npm run build`（tsc -b && vite build）✓ built in 1.12s。冒烟按口径由用户手动执行
- **审查结论**：Review Agent（独立新上下文）首轮 **REQUEST_CHANGES**（1 Blocking：口径「输入类 1px #E2E8F0 + 底 #FAFBFC」未落地）→ 已补 `tokens.color.inputBorder/inputBg` + 主题 `components.Input/Select` 覆盖并回填 §3.1 → 复审 **APPROVE**（0 Blocking，3 Non-blocking）。**追加**：用户反馈「未选中页面时内容区无变化」——定位为 PageEditor 空状态裸 `<Empty>` 未套 Panel，已补套 `Panel` 并居中，属既定「三区统一白面板」范围内的遗漏补齐；范围经用户裁决为**仅统一内容区白面板、底色保持 `#F8FAFC`**（不做布局重构）→ 该增量复审 **APPROVE**（无 Blocking；已核验父链高度确定使 `Panel height:100%` 正常解析、Empty 居中无横向溢出、无越界）。**再追加**：用户指出左侧「同步课程」列未做卡片形式 → 已把 `Sider` 去右边框 / 改灰底 / 加内边距、`Sidebar` 根节点改 `Panel`，卡片化并与右侧内容面板对称统一 → 增量复审 **APPROVE**（无 Blocking，3 Non-blocking：① `MainLayout` JSDoc 描述过时——**已当场修**（改为「内容区与课程树列为灰底上的白色圆角卡片」）；② `overflow: visible` 稳健性提示；③ 卡片内边距使树区可用宽度 276→236，与右侧对称、符合 §3.1）
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：用户手动冒烟外观（Knowledge Pages 空/满、左侧课程树列卡片、Releases、AI Tutor 配置与对话）

---

## 2026-10-19 ｜ 左侧树搜索扩展（匹配标题+Heading）并修复无结果空白 bug

- **任务**（用户反馈）：① Bug——搜索无匹配结果时下方 md 文件全部消失（整树空白，无提示）；② 需求——搜索除 Page 标题外，还应匹配全部 Heading 以定位（左栏本就列出所有 heading）。
- **用户裁决**（AskUserQuestion）：① 无结果时→**显示「无匹配结果」空态提示**；② 命中展示→**标题命中显示该页全部 Heading，仅 Heading 命中则只显示匹配的 Heading**；③ 匹配范围→**仅 Page 标题 + Heading，不含正文**。
- **根因**：原实现 [CourseTree.tsx:139](file:///c:/Users/Jackcao/Desktop/晓秒科技公司文档/KnowledgeSystem/client/src/components/knowledge/CourseTree.tsx) 在无匹配时 Course 节点返回 `null`，`treeData` 变空 → 整片空白且无空态提示。
- **变更清单**：
  - **设计文档**（先改后实现）：§3.2.1 搜索条描述更新为「匹配 Page 标题 + 全部 Heading（H1-H6）；标题命中→显示该页全部 Heading、仅 Heading 命中→只显示匹配 Heading；无结果时显示空态提示」
  - **前端 `CourseTree.tsx`**：`treeData` 内 Page 过滤逻辑改为 `flatMap`——`titleMatch` 或 `visibleHeadings.length>0` 才纳入；`visibleHeadings = !kw ? 全部 : titleMatch ? 全部 : 仅匹配 heading`；新增无结果分支：`kw && treeData.length===0` 时渲染 `<Empty>无匹配结果</Empty>` 替代 `<Tree>`（关键字清空后自动恢复全部 md 文件）
  - **前端 `SearchBox.tsx`**：placeholder「搜索页面标题…」→「搜索标题或 heading…」，注释同步
- **自测证据**：前端 `npx tsc --noEmit` 0 错误；`npm run build`（tsc -b && vite build）✓ built in 1.06s
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，3 Non-blocking）：① `parseHeadings` 逐行正则不识别代码围栏，代码块内 `# 注释` 可能被当作 heading 误匹配（**既有解析器局限**，非本次引入）；② heading 节点 key 为 `course:page:level:text`，同页同层级同名 heading 会重复 key（罕见，与既有 slug 碰撞问题同源）；③ 空态条件 `kw && treeData.length===0` 在搜索瞬间详情未加载时也会落入（窗口极短，非阻塞）。评审实测：client tsc 0 错 / build ✓；四项口径逐条核对一致
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：用户手动冒烟（无结果提示 / 标题命中显示全 heading / 仅 heading 命中只显示匹配项 / 点击 heading 定位）

---

## 2026-10-19 ｜ .doc/.xls 扩充复审后收尾（.xls 魔数校验 + §10.2 陈旧引用修正）

- **任务**：处理上一条目 Review 提出的 3 项 Non-blocking 裁决结果并收尾。
- **用户裁决**（AskUserQuestion）：① `xlsx@0.18.5` CVE → **保持现状（接受风险）**（既有风险，markitdown-ts 早已依赖；npm registry 无更高版本）；② `.xls` → **加魔数校验**；③ 设计文档 §10.2 → **一并修正陈旧引用**。
- **变更清单**：
  - **后端 `files.service.ts`**：`convertFile` 在大小校验后新增 `.xls` 内容签名校验——非 OLE/BIFF 直接 `BadRequestException('文件内容不是有效的 .xls 格式（请确认文件类型）')`；新增私有方法 `isLegacyXls`（匹配 OLE 复合文档头 `D0 CF 11 E0 A1 B1 1A E1`，或裸 BIFF BOF 小端首字节 `0x09`），避免 SheetJS 对被改扩展名的纯文本宽松解析产出垃圾表格
  - **设计文档 §10.2**：步骤 2 交叉引用 `§5.1.6` → `§5.1.5`；步骤 7「经 §5.1.3 页面创建接口在指定 Lesson 下新建 Page」→「经 §5.1.2 …在指定 Course 下新建 Page（2026-10-16 扁平化后无 Lesson 层，Page 直接挂 Course）」
  - **测试**：`files.service.spec.ts` 新增 1 条（伪装 .xls 纯文本应 reject 且消息含「不是有效的 .xls」，并验证 `.md` 不走该分支）；`files.e2e-spec.ts` 新增 1 条（POST /api/files/convert 上传 fake.xls 应 400 且含同文案）
  - xlsx CVE：按用户裁决**不改动**（保留现状）
- **自测证据**：
  - 后端 `npx tsc --noEmit` 0 错误；`npm test` **52/52 PASS**；`npm run test:e2e` **58/58 PASS**
  - 前端 `npx tsc --noEmit` 0 错误；`npm run build`（tsc -b && vite build）✓ built in 1.05s
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，7 Non-blocking）：全部非阻塞项无新增风险——① `.xls` 裸 BIFF 第二字节判定 `<=0x08` 略宽，可收敛为版本白名单（影响极小，SheetJS 解析兜底）；② `.doc` 无显式魔数校验（符合本次「仅 .xls 加」裁决，口径可后续统一）；③ 表格仅转义 `|`/换行，其余 Markdown/HTML 原样透传（与既有 txt/md/html 同一风险类，非本次引入）；④ `.doc` 真实样例单测软依赖（既有策略）；⑤ `xlsx@0.18.5` CVE（用户已裁决保持现状，既有风险）；⑥ `server/e2e_out.txt` 疑似 e2e 调试残留（本 9 文件范围外，建议清理/加 `.gitignore`）；⑦ §10.3 选型表未新增表格行（仅注记补充，不影响一致性）。评审实测复核：server tsc 0 错 / 单测 52/52 / e2e 58/58；client tsc 0 错 / build ✓
- **Git**：本地未提交（攒批，等待用户指令再推送）
- **下一步**：Review 复审 → 用户手动冒烟上传 `sample_legacy.xls` / `sample_doc_legacy.doc` 验证预览与建页

---

## 2026-10-19 ｜ 文件上传扩充旧版格式 .doc / .xls（专用库 + 测试样例）

- **任务**：用户要求文件上传功能新增支持旧版二进制 `.doc` / `.xls`，并在 `test_files/upload/` 生成两种格式样例供手动测试。
- **用户裁决**（AskUserQuestion）：① 转换方案 = **新增专用库**——`.xls` 用 SheetJS（`xlsx`）转 Markdown 表格、`.doc` 用 `word-extractor` 提取纯文本，其余仍走 markitdown-ts（已知限制：`.doc` 仅纯文本，无标题层级/表格/图片）；② `.doc` 样例 = **用本机 Word COM 自动生成**。
- **变更清单**：
  - **设计文档**（先改后实现）：§10.1 允许格式行加 `doc,xls` + 新增「白名单扩充（2026-10-19）」注记（含限制说明）；§10.2 第 5 步（转换分支）；§10.3 补充选型注记；§3.2.3 文案「8 格式」→「10 格式」；§5.1.5 接口说明；§9 env 示例；§12 事项 #3
  - **后端 `files.service.ts`**：`ALLOWED_EXTENSIONS` 增 `.doc`/`.xls`；`convertFile` 增分支（`.xls`→`xlsToMarkdown`、`.doc`→`docToMarkdown`、其余→markitdown-ts）；新增私有方法 `xlsToMarkdown`（SheetJS 逐表转 Markdown 表格）、`rowsToMarkdownTable`（空行过滤/列宽对齐/`|` 转义/换行替换）、`docToMarkdown`（`word-extractor.getBody()`）；导入 `import * as XLSX from 'xlsx'`、`import WordExtractor from 'word-extractor'`
  - **新增 `server/src/types/word-extractor.d.ts`**：word-extractor 无官方类型，做最小 ambient 声明（`export = WordExtractor`，`extract(string|Buffer): Promise<{ getBody(): string }>`）
  - **依赖**：`server/package.json` 新增直接依赖 `xlsx@0.18.5`、`word-extractor@1.0.4`（lock 已固化 integrity）
  - **前端 `api/knowledge.ts`**：`UPLOAD_ALLOWED_EXTENSIONS` 增 `.doc`/`.xls`（弹窗格式文案由该数组派生，自动含 DOC、XLS）
  - **测试**：`files.service.spec.ts` 新增 3 条（.xls 转表格 / .doc·.xls 白名单断言 + .doc 损坏报「转换失败」/ .doc 真实样例提取纯文本，样例缺失则 `it.skip`）；`files.e2e-spec.ts` 新增 1 条 .xls 上传 e2e
  - **测试样例**：`test_files/upload/sample_legacy.xls`（SheetJS，双表 Syllabus/Glossary）、`sample_doc_legacy.doc`（Word COM 另存为 97-2003，24576B）
- **自测证据**：
  - 后端 `npx tsc --noEmit` 0 错误；`npm test` **51/51 PASS**；`npm run test:e2e` **57/57 PASS**
  - 前端 `npx tsc --noEmit` 0 错误；`npm run build` ✓ built in 1.04s
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，5 Non-blocking）：① 本次 AI 协作日志（本条，已补）；② `xlsx@0.18.5` 携带高危 CVE（Prototype Pollution/ReDoS，npm registry 上限即 0.18.5，`fixAvailable:false`）——**既有风险（markitdown-ts 早已依赖并解析 .xlsx），非本次引入**，建议改用 SheetJS 官方 CDN 0.20.x 或 exceljs，需用户裁决；③ `.xls` 对非 xls 内容 SheetJS 宽松解析不报错，建议加 OLE/BIFF 魔数（`D0 CF 11 E0 A1 B1 1A E1`）校验；④ `.doc` 真实样例单测对 `test_files` 存在性有软依赖（缺失静默 skip）；⑤ 送审范围提示（工作树另有大量无关未提交变更，需另行送审/拆分提交）
- **设计偏差上报**：§10.2 存在两处陈旧交叉引用（步骤 2 引「§5.1.6」应为 §5.1.5；步骤 7 写「经 §5.1.3…在指定 Lesson 下建 Page」应为 §5.1.2 且 2026-10-16 扁平化后**无 Lesson 层**）——既有问题，本次未引入，待用户裁决是否修订
- **Git**：本地未提交（攒批）
- **下一步**：用户手动冒烟——上传 `sample_legacy.xls` 与 `sample_doc_legacy.doc`，确认弹窗预览为 Markdown 表格 / 纯文本且可 Import 建页；并裁决 N②（xlsx CVE）与 N③（.xls 魔数校验）是否处理

---

## 2026-10-19 ｜ 模块导航列收起把手改版（半圆括号贴边把手 + ❮/❯ 文本符号）

- **任务**：用户对刚实现的「最左侧模块导航列可收起」按钮提出改版——做得更大、**不要圆形**，改为**类似括号的贴边样式**；并使「<」「>」符号**加粗、加大一号**。
- **用户裁决**（AskUserQuestion）：形状选**半圆括号（贴边把手）**——外侧整边圆弧、内侧平直、紧贴导航列右边缘垂直居中（不再跨边界）；符号采用**文本符号加大加粗**（AntD 图标为填充路径无法用 `font-weight` 加粗，故换文本字符）。
- **变更清单**：
  - **设计文档**（先改后实现）：`:224` 注记更新为「形态更新为半圆括号式贴边把手（外侧整边圆弧、内侧平直，约 22×48）+ 方向符号用文本 ❮ / ❯（fontSize 16 / fontWeight 700）」
  - **前端 `MainLayout.tsx`**：移除 `LeftOutlined/RightOutlined` 导入；收起把手按钮改为 `width:22 height:48`、`borderRadius:'0 50% 50% 0'`（右侧整边半椭圆弧）、`borderLeft:'none'`（内侧平直，与面板右边框不叠线）；定位改为 `left: navCollapsed ? 0 : NAV_WIDTH` + `top:'50%'` + `transform:'translateY(-50%)'`（仅垂直居中，**不再用 `translate(-50%, …)` 跨边界**）；`transition` 收敛为仅 `left 0.2s ease`（与列宽过渡同步）；内容改为 `<span>` 文本符号 `{navCollapsed ? '❯' : '❮'}`，字号 `tokens.fontSize['2xl']`(16)、字重 `tokens.fontWeight.bold`(700)、`lineHeight:1`；文件头注释同步
- **自测证据**：
  - 前端 `npx tsc --noEmit`：0 错误；`npm run build`（tsc -b && vite build）：✓ built in 1.19s
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，3 Non-blocking：① `NAV_WIDTH` 与 `ModuleNav.tsx` 内 `width:160` 重复；② 把手几何 `22/48`、`zIndex:10` 为字面量；③ 送审范围仅本次 2 文件，工作树其余未提交变更需另行送审）。评审确认几何换算（22×48 + `0 50% 50% 0` 形成完整半椭圆弧）、收起/展开定位、Token 复用、无残留导入、文档一致
- **Git**：本地未提交（攒批）
- **下一步**：用户手动冒烟——① 把手是否为「外侧圆弧、内侧平直」的半圆括号贴边形态且紧贴右边缘垂直居中；② 收起后是否停靠最左边缘完整可见；③ ❮ / ❯ 是否明显加粗放大

---

## 2026-10-19 ｜ 最左侧模块导航列（Knowledge / AI Tutor）可向左收起

- **任务**：用户要求最左侧模块导航列（Knowledge / AI Tutor）增加「向左收起」功能，按钮置于该列右边缘垂直居中、贴板块最右侧。
- **用户拍板**（AskUserQuestion）：形态为**完全收起隐藏**（整列向左滑出隐藏，按钮随停靠到最左边缘），而非收成窄条/仅图标条。
- **变更清单**：
  - **设计文档**（先改后实现）：§3.1 布局附近（约 `:224`）新增「2026-10-19 模块导航列可收起」注记
  - **前端 `MainLayout.tsx`**：新增 `useState` 与 `LeftOutlined/RightOutlined` 导入；新增常量 `NAV_WIDTH = 160` 与 `navCollapsed` state；将 `ModuleNav` 包进 `position: relative` 外层 wrapper，内层 div `width: navCollapsed ? 0 : NAV_WIDTH` + `overflow: hidden` + `transition: width 0.2s ease`（整列向左滑出裁切）；新增绝对定位圆钮（22×22，`borderRadius: 50%`，`boxShadow: tokens.shadow.card`）——展开态 `left: NAV_WIDTH` + `translate(-50%, -50%)`（跨在列右边缘上），收起态 `left: 0` + `translateY(-50%)`（贴最左边缘完整显示，避免被视口裁掉一半）；图标 `LeftOutlined`（展开态）/ `RightOutlined`（收起态）；补 `aria-label`/`title`；`transition: 'left 0.2s ease, transform 0.2s ease'` 与列宽度过渡同步
- **自测证据**：
  - 前端 `tsc --noEmit`：0 错误；`npm run build`（tsc -b && vite build）：✓ built in 1.21s
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，5 Non-blocking）。评审确认收起/展开逻辑、按钮定位（含收起态防裁切）、过渡动画正确；已处理 **N1**（按钮补 `transition: 'left 0.2s ease, transform 0.2s ease'`）；其余 Non-blocking 见「遗留」
- **Git**：本地未提交（攒批）
- **下一步**：用户手动冒烟——① 点击右边缘按钮，确认导航列整列向左滑出隐藏、按钮停到最左边缘；② 再次点击确认展开复位；③ 按钮位于该列右边缘垂直居中、贴板块最右侧
- **遗留/备注**（Review Non-blocking，未处理）：**N2** `NAV_WIDTH` 常量与 `ModuleNav.tsx` 内 `width: 160` 重复，可提取共享常量；**N4** 收起态未持久化（刷新后恢复展开，如需记忆需接 localStorage）；**N5** 按钮 22px 为取值决定，如与 Figma 规范有出入可再调

---

## 2026-10-19 ｜ Releases（原 Publish）面板 5 项调整 + 更名文案贯通

- **任务**（用户提出 5 点修正）：① Releases 界面下不应显示左侧课程树边栏（同步目标/课程树/Sync 按钮），但保留最左侧模块导航列；② Tab 名 `Publish` → `Releases`；③ 列表上方新增标题行 `Knowledge Releases`；④ 列 `Current Version` → `Latest Release`；⑤ 按钮 `Publish` → `Create Release`
- **用户裁决**（AskUserQuestion）：① **隐藏整个课程树边栏，但不隐藏 Knowledge/AI Tutor 模块导航列**；④ 拼写用 **Latest Release**（用户原写 Lastest，确认为笔误）；后追加：AI Tutor 用户可见提示文案「请先在 Knowledge 模块 Publish」**一并改为 Releases**
- **变更清单**：
  - **设计文档**（先改后实现）：§3.1 布局（Tab 名 `Releases`、Releases 下隐藏课程树栏）、新增「2026-10-19 Releases Tab 调整」注记、§3.4 标题/表格列（`Knowledge Releases` 标题行、`Latest Release`、`Create Release`）、§3.4.2 标题、§3.4.3 标题与流程文字、§4.4 未发布提示文案
  - **前端 `KnowledgeTabBar.tsx`**：TABS 第二项 label `Publish` → `Releases`（tab key 内部仍为 `'publish'`）
  - **前端 `PublishPanel.tsx`**：新增 `Typography.Title level={4}` 标题行 `Knowledge Releases`；列 title → `Latest Release`；Action 按钮 → `Create Release`；发布 Modal 说明 → `Create Release …`；文件头注释同步
  - **前端 `App.tsx`**：`sidebar` 增加 tab 条件——`activeModule === 'knowledge' && knowledgeTab === 'pages'` 才渲染侧栏；`topBar`（Tab 栏）与 `MainLayout` 最左侧 `ModuleNav` 不受影响
  - **后端 `ai-chat.service.ts`**：两处未发布错误文案 → 「该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本」；`buildContext` 注释同步
  - **测试 `server/test/ai.e2e-spec.ts`**：断言 `toContain('Publish')` → `toContain('Releases')`
- **自测证据**：
  - 前端 `tsc --noEmit` 0 错误；`npm run build`（tsc -b && vite build）✓ built
  - 后端 `tsc --noEmit` 0 错误；`npm test` **48/48 PASS**；`npm run test:e2e` **56/56 PASS**
- **审查结论**：Review Agent（独立新上下文）首轮 **REQUEST_CHANGES**（5 点本体全对；1 Blocking：AI Tutor 用户可见文案「用户可见的过时 Publish 文案」未同步）；经用户裁决一并修改后复审 **APPROVE**（0 Blocking）。评审过程同时确认 `topBar`/`ModuleNav` 保留、`Current Version` 无残留、`Typography.Title` 导出链正常
- **Git**：本地未提交（攒批）
- **下一步**：用户手动冒烟——① 切到 Releases tab，确认左侧课程树栏消失、最左侧模块导航仍在，切回 Knowledge Pages 恢复；② Tab 名、标题行、列名、按钮文案；③ AI Tutor 未发布课程时提示文案指向 Releases
- **遗留/备注**：切 tab 会卸载 `Sidebar`，切回时 `loadExternalCourses` 会重复拉取、课程树展开态/搜索词重置（既有机制，Store 数据不丢，非本次引入）；`PublishPanel` 组件名与 tab key `'publish'` 作为内部标识保留

---

## 2026-10-19 ｜ Heading 标签/TOC 支持范围由 H1/H2/H3 扩展至 H1-H6

- **任务**：用户指出「md 编辑功能目前只有 heading1/2/3 支持标签，希望所有 heading 都支持标签」。经排查，BlockNote heading schema 原生支持 6 级（`HEADING_LEVELS=[1..6]`），但项目只在 H1/H2/H3 范围内实现标签与 TOC。
- **用户拍板**（AskUserQuestion）：**全部扩展到 H1-H6**——标签、左侧 TOC、右键插入菜单同步放开 H4-H6，后端 sectionTags 迁移过滤与 AI 上下文分段正则一并由 `#{1,3}` 放宽为 `#{1,6}`。
- **变更清单**：
  - **设计文档**（先改后实现）：§2 schema 注释（`:96`）、§2 历史叙述注记（`:55`）、§3.2 扁平化注记补「2026-10-19 层级扩展改拍」（`:218`）、§3.2.1 树形导航（`:226`/`:230`）、§3.3.2 块菜单与第 5 条（`:303`/`:308`）、§3.3.3 section tags（`:337`）、§4.4.2 知识库上下文（`:505`）
  - **前端 `PageEditor.tsx`**：4 处 `querySelectorAll('h1,h2,h3')` → `'h1,h2,h3,h4,h5,h6'`（TOC 定位 / tag 位置更新 / heading key 列表 / headingKeys 变化后定位）；右键菜单 heading 子项新增 heading4/5/6「四级/五级/六级标题」；相关注释同步
  - **前端 `CourseTree.tsx`**：`parseHeadings` 正则 `^(#{1,3})` → `^(#{1,6})`；注释同步（字体层级维持 level1=md / level2=sm / 3-6=xs）
  - **后端 `sync.service.ts`**：`extractHeadingKeys`（sectionTags 迁移过滤）正则 `#{1,3}` → `#{1,6}`
  - **后端 `ai-chat.service.ts`**：`splitByHeadings`（AI 上下文分段）正则 `#{1,3}` → `#{1,6}`
  - **注释一致性**：`schema.prisma`、`create-page.dto.ts`、`client/api/knowledge.ts`、`client/stores/knowledgeStore.ts` 的 `H1/H2/H3` → `H1-H6`（注释级，无 Schema 变更、无需迁移）
- **自测证据**：
  - 前端 `tsc --noEmit`：0 错误；`npm run build`：✓ built
  - 后端 `tsc --noEmit`：0 错误；`npm test`：**48/48 PASS**；`npm run test:e2e`：**56/56 PASS**
- **审查结论**：Review Agent（独立新上下文）**APPROVE**（0 Blocking，5 Non-blocking）。已落地的 Non-blocking：① CourseTree `HeadingInfo` 注释 `(1-3)`→`(1-6)`；② 设计文档 §2 历史注记同步层级范围。其余待办：AI 协作日志本条（正在补）、同级同名 heading 的 `h{n}-slug` key 碰撞（既有问题，扩至 6 级后触发面上升）、H4-H6 专项用例缺失（可选补）
- **Git**：本地未提交（攒批）
- **下一步**：用户手动冒烟——① 编辑器内插入 H4/H5/H6 后右侧是否出现标签按钮；② 左侧 TOC 是否展示 H4-H6 且点击可定位；③ 后端同步迁移/AI 上下文对 H4-H6 标签是否生效。完成后询问用户是否推送分支/发 PR
- **遗留/已知限制**：同级同名标题（如多个 `#### 注意事项`）会生成相同 `h{n}-slug`，导致标签覆盖层 React key 重复与 TOC 节点 key 冲突（H1-H3 时已存在，本次未引入）；如需修复需引入出现次序消歧，涉及 headingKey 规则变更，待用户裁决

---

## 2026-10-19 ｜ 页面标题铅笔按钮位置 + LaTeX 粘贴自动转公式块

- **任务**：用户两项需求——① 调整页面标题（md 文件名称）右侧铅笔按钮位置，使其紧贴标题名称右侧并垂直居中；② 复制 LaTeX 内容粘贴时被 BlockNote 默认转为 code block，要求粘贴后直接渲染为公式。
- **用户拍板**：
  - 铅笔位置：标题 div 移除 `flex: 1`（收缩到文字宽度），保存状态 Tag 加 `marginLeft: 'auto'` 仍贴右，铅笔按钮靠 `gap` 紧贴标题右侧，`alignItems: 'center'` 保证垂直居中
  - LaTeX 粘贴：**方案 A**（自定义粘贴拦截）；复制来源 VSCode + 网页；普通代码保持 code block
- **变更清单**：
  - `PageEditor.tsx` 标题展示态 div 移除 `flex: 1`，保存 Tag 加 `marginLeft: 'auto'`
  - 新增工具函数 `looksLikeLatex(text)`（触发条件：`$$...$$` 块公式 / 常见 LaTeX 命令 / `$...$` 内含已知命令，避免 `\n` `\d` 普通转义误判）和 `extractCodeFromHtml(html)`（DOMParser 提取所有 `<pre>`/`<code>` textContent，正确处理实体）
  - `useCreateBlockNote` 新增 `pasteHandler` 选项（而非 React onPaste，因 BlockNote 内部已在 view.dom 注册原生 paste 并 preventDefault，React onPaste 会在其后触发导致重复插入）：优先用 text/plain 判断 LaTeX，否则从 text/html 代码块提取；命中则 `tryParseMarkdownToBlocks` + `convertMathParagraphs` 解析插入（空段落 replace、否则 after；空文档追加末尾），用 insertBlocks/replaceBlocks 返回的带 id 块定位光标，`return true` 拦截；非 LaTeX 或解析空结果 `return defaultPasteHandler()` 走默认；异常 `message.warning`
- **自测证据**：
  - 前端 `tsc --noEmit`：0 错误；`vite build`：✓ built（tsc -b && vite build）
- **审查结论**：Review Agent 复审 **APPROVE**（首轮 REQUEST_CHANGES，2 Blocking：B1 改用 pasteHandler 解决重复插入、B2 用插入返回值带 id 块定位光标；4 Non-blocking 全部落实：N1 收紧条件3、N2 空结果回退默认、N3 提取所有代码块、N4 DOMParser 处理实体）
- **Git**：本地未提交（攒批）
- **下一步**：用户手动冒烟——① 铅笔按钮是否紧贴标题右侧且垂直居中；② 从 VSCode/网页复制 `$$...$$` / `$...$` 粘贴是否直接渲染为公式块；③ 粘贴普通代码是否仍保留 code block；④ 空段落粘贴替换 / 非空段落 after 插入 / 空文档追加末尾三种场景

---

## 2026-10-19 ｜ Knowledge 整宽 Tab 栏 + 页面标题铅笔就地编辑（对齐 Figma 1.1 Page Editor）

- **任务**：用户要求两处 Knowledge System UI 调整——① 将「Knowledge Pages / Publish」整行 Tab 位置提升到课程树「同步目标」栏的上方；② 页面标题（md 文件名称）编辑改为 Figma「Population Growth」形式：默认展示大标题 + 右侧常显铅笔按钮，点击就地变输入框编辑。格式对齐 Figma 缓存 `YL-KS+AI_UIIFinal-20261019-105235` 中的帧 `1.1 Page Editor`（节点 665:543，1672×941）。
- **用户拍板**（AskUserQuestion）：
  - 布局调整：**整宽 Tab 栏**——把「Knowledge Pages / Publish」整行提升为跨「课程树列 + 编辑器」的整宽 Tab 栏，位于同步目标上方（模块导航列保持左侧整高）
  - 标题编辑：**常显铅笔 + 就地编辑**——默认展示态大标题 + 右侧常显铅笔按钮，点击就地变输入框，Enter/失焦保存、Esc 取消回滚
  - Tab 样式：**按 Figma 调整**——激活 `#145CFF`、16px/600、底部 2px 激活下划线 + 整条底边线；非激活 `#000000`
- **Figma 关键事实**（缓存 JSON 解析）：帧 `1.1 Page Editor` 布局为 Header(y0–68) → 模块导航列(宽 280 全高) → 其右侧顶部整宽 Tab 栏(y68–131，`Rectangle 6` 从 x281 延伸至右缘) → 下方课程树面板(含同步目标，y152 起) 与编辑器卡片(`Rectangle 8`，x583 起)。Tab：`Knowledge Pages` 16px/600 `#145CFF`（激活）、`Publish` 16px/600 `#000000`，激活下划线 `Rectangle 5` 138×2。标题：`Population Growth` 30px/700 `#000000`，右侧 `Frame 42`(20×20) 含 16×16 铅笔 vector(`edit-icon`)，下方分隔线 `Line 67`。
- **变更清单**：
  - **设计文档**：§3.1 改写为「顶部整宽 Tab 栏 + 下方左右两栏」并新增 2026-10-19 改拍注记（对齐 Figma 帧 665:543，Tab 样式规范）；§3.3.1 改写为「常显大标题（约 30px/700/黑）+ 右侧常显铅笔按钮（16×16 图标 / 20×20 容器）；点击铅笔→就地输入框；Enter/失焦保存、Esc 取消回滚；标题下方分隔线」；§3.3.2 第 5 条措辞更新
  - **前端**：`MainLayout.tsx` 新增 `topBar` 插槽（props 增加 `topBar?: React.ReactNode`，结构改为模块导航列 + 右列[topBar + 左右两栏]）；**新建** `knowledge/KnowledgeTabBar.tsx`（自绘 Figma 风格 Tab，role=tablist/tab/aria-selected，激活 #145CFF + 2px 下划线）；`App.tsx` 新增 `knowledgeTab` 状态并传 `topBar`；`KnowledgeSystem.tsx` 移除 antd `Tabs`，改为接收 `tab` prop 的内容渲染器；`PageEditor.tsx` 标题区改为展示态/编辑态切换（`editingTitle` 状态 + `titleBeforeEdit` ref；展示态 30px/700 `#000000` 大标题 + 20×20 常显铅笔按钮（`EditOutlined` 16px）；编辑态 `Input` autoFocus，Enter/失焦保存、Esc 回滚）
- **自测证据**：
  - 前端 `tsc --noEmit`：0 错误；`vite build`：✓ built in 1.06s；后端不受影响（无后端变更）
- **审查结论**：Review Agent **APPROVE**（0 Blocking，6 Non-blocking）；已采纳修补：铅笔按钮尺寸对齐 Figma（20×20 容器 / 16px 图标）、标题色改纯黑 `#000000`（原 `text.primary #1E293B`）；用户裁决采纳 Non-blocking #1：统一空标题文案（编辑态 placeholder「页面标题」→「未命名页面」，与展示态回退一致）；其余 Non-blocking（原生 button 注释、Esc 与防抖中间写库语义、tabpanel/键盘导航、工作区攒批文件提交范围）为可选/固有语义
- **Git**：本地未提交（攒批）
- **下一步**：用户手动冒烟（Tab 整宽位置与样式、点击铅笔就地编辑标题、Enter/失焦保存、Esc 取消、刷新后标题持久化）→ 确认后询问用户是否推送分支/发 PR

---

## 2026-10-19 ｜ 左侧课程树 Page 拖拽排序（悬停把手 + 批量排序接口）

- **任务**：用户要求「lesson 的左侧添加拖动机制，能够调整它们的位置」——即课程树中 Page 节点的拖拽排序。
- **用户拍板**（AskUserQuestion）：
  - 拖拽范围：**全部 Page 均可拖拽**（含 STALE/外部同步页）
  - 把手交互：**悬停显示把手**（行左侧 ⣿，按住把手拖动）
  - 排序接口：**新增批量排序接口** `PUT /api/courses/:courseId/pages/reorder`，body `{ orderedIds: string[] }`，事务内按数组下标重写 `sortOrder`
- **变更清单**：
  - **设计文档**：§3.2.1 树形导航新增「Page 节点支持拖拽排序（2026-10-19 新增）」条目并补「搜索过滤时禁用拖拽」；§5.1.2 表格新增 `PUT /api/courses/:courseId/pages/reorder` 行 + 校验说明（orderedIds 须无重复且集合等于该 Course 全部 Page id，否则 400 VALIDATION_ERROR；courseId 不存在 404）
  - **后端**：新增 `pages/dto/reorder-pages.dto.ts`（`@IsArray + @ArrayNotEmpty + @IsString({each:true})`）；`pages.service.ts` 新增 `reorder()`（校验 courseId 存在→校验 orderedIds 为全部 Page 的完整排列→`$transaction` 批量 `update sortOrder=index`）；`pages.controller.ts` 新增 `@Put('courses/:courseId/pages/reorder')`；`test/knowledge.e2e-spec.ts` 新增 5 用例（成功重排 + 非完整排列 400 + 空数组 400 + 含重复 id 400 + 课程不存在 404）
  - **前端**：`api/knowledge.ts` 新增 `reorderPages(courseId, orderedIds)`；`knowledgeStore.ts` 新增 `reorderPages`（乐观更新本地 sortOrder + 失败 `refreshDetail` 回滚）；`CourseTree.tsx` 用原生 HTML5 DnD（非 antd 内置 draggable，避免整行拖拽/reparenting）实现悬停把手拖拽：新增 `draggingId`/`dropTarget` 状态、`resolveDropPos`（按指针 Y 与行中点判定 before/after）、`performReorder`（移除再插入、顺序不变不发请求、失败 message.error），行根 div 绑定 onDragOver/onDragLeave/onDrop + 插入线 boxShadow，左侧 `HolderOutlined` 把手 `draggable` 触发 onDragStart；`index.css` 新增 `.page-drag-handle` 悬停显隐/光标样式
- **自测证据**：
  - 后端 `tsc --noEmit`：0 错误；单测 48/48 PASS；**e2e 56/56 PASS**（含新增 5 个 reorder 用例：成功/非完整排列/空数组/重复 id/课程不存在）
  - 前端 `tsc --noEmit`：0 错误；`vite build`：✓ built in 1.41s；`eslint`：0 errors（4 warnings 为既有 react-hooks 告警）
- **审查结论**：Review Agent **APPROVE**（0 Blocking）；4 项 Non-blocking：① 工作区 40 文件为历史攒批，提交时须只暂存本功能 10 文件（建议采纳）；② 补重复 id e2e 用例（**已采纳，补后 e2e 56/56**）；③ §5.1.2 对「0 页 Course 空数组」未明确（UI 不可达，忽略）；④ reorder 无并发乐观锁（可接受）
- **Git**：本地未提交（攒批）
- **下一步**：送 Review Agent 独立审查 → 用户手动冒烟（悬停出现把手、按住把手拖拽、插入线提示、松手排序持久化、刷新后顺序保持）→ 确认后询问用户是否推送分支

---

## 2026-10-16 ｜ Tag 体系重构：移除页面级 tags，section tags 扩展至 H1-3，引入全局 Tag 词库（方案 B 轻量版）

- **任务**：用户确认当前 tag 方案后裁决——移除页面级 tags，仅保留 section tags；section tags 从仅 H2 扩展到 H1/H2/H3（key 改为 `h{n}-slug` 带层级前缀）；引入全局 Tag 词库（方案 B 轻量版：输入即沉淀、颜色自动分配、AutoComplete 联想）。
- **用户拍板**：
  - 移除页面级 `Page.tags`，仅保留 `sectionTags`
  - section tags 绑定 H1/H2/H3，key = `h{n}-{slug}`（层级前缀避免同名冲突）
  - 方案 B 轻量版：独立 `Tag` 表，初始 4 个预设 tag（Core Knowledge=蓝、Teaching Guidance=绿、Misconception=橙、Assessment=紫）；用户输入新 tag 自动写入词库，颜色按 name 哈希自动分配；第一版不做独立管理界面
- **变更清单**：
  - **设计文档**：§2 Page 模型删 tags、新增 Tag 模型；§3.3.3 重写（去页面级 tags、section tags 支持 H1-3、方案 B 词库）；§3.3.2 顶部栏去 tags；§3.2.2 同步方案 C 去页面级 tags 迁移；§3.4 快照去 tags；§4.4.2 AI 上下文按 H1-3 切分；§5.1.2 Page 更新去 tags；新增 §5.1.6 Tag 词库接口
  - **后端**：`schema.prisma` 删 `Page.tags`、新增 `Tag(name unique, color)`；迁移 `20261016072726_remove_page_tags_add_tag_table`；新增 `tags/` 模块（`TagsService.listTags/createTag`、颜色哈希分配 `pickColor`、`TagsController` GET/POST `/api/tags`），注册到 AppModule；Pages DTO/Service 去 tags；Sync `migrateTags` 返回仅 sectionTags、`extractHeadingKeys` 支持 H1-3；Releases 快照/激活去 tags；AI `buildContext` 用 `splitByHeadings`（H1-3）+ `headingKey` 切分拼接 `[TAGS: ...]`；seed 新增 4 个预设 tag
  - **前端**：`api/knowledge.ts`（PageNode/ReleaseDetail 去 tags、新增 `TagItem` 类型与 `listTags/createTag` 接口）；`knowledgeStore.ts`（PageDraft 去 tags、新增 `tags` 词库状态与 `loadTags/createTag`）；`TagManager.tsx` 重写（AutoComplete 联想词库、命中用词库配色、未命中调 createTag 沉淀、同名颜色稳定）；`PageEditor.tsx`（去顶部页面级 TagManager、H1/H2/H3 下方 portal 注入 section tags、key 用 `headingKey`）；`ui/index.ts` 透传 AutoComplete
  - **测试**：`releases.service.spec.ts`、`knowledge.e2e-spec.ts` 去 tags，改用 sectionTags（`h{n}-slug` 格式）
- **自测证据**：
  - 后端 `tsc --noEmit`：0 错误；单测 35/35 PASS；e2e 40/40 PASS
  - 前端 `tsc -b --noEmit`：0 错误；`vite build`：✓ built in 1.30s
  - 数据库验证：4 个预设 tag 正确入库（Assessment=purple、Core Knowledge=blue、Misconception=orange、Teaching Guidance=green）
- **审查结论**：待 Review Agent 审查
- **Git**：本地未提交
- **下一步**：送 Review Agent 审查 → 用户冒烟（H1-3 section tags 编辑、新词库 tag 自动沉淀配色、同步 STALE 迁移）→ 确认后推送分支

---

## 2026-10-16 ｜ 扁平化改造：Knowledge System 三级→两级（Course→Page）+ TOC + H2 section tags

- **任务**：用户要求将 Course → Lesson → Page 三级结构扁平化为 Course → Page 两级，新增目录（TOC）功能，每个 H2 heading 可单独打用户自定义 tags（sectionTags，用于 AI 语义标注）。同步 STALE 方案 C：整页 STALE + 重建，但按 heading slug 迁移旧 Page 的 sectionTags。
- **用户拍板**：
  - 数据可重置（删库重建 + 新 seed）
  - TOC 集成在课程树列内（Course → Page → Heading 三级展开），不另开窗口
  - H2 sectionTags：`{ "heading-slug": ["tag1","tag2"] }`，key 为 H2 文本 slug
  - 同步方案 C：整页 STALE + 重建，按 H2 slug 迁移旧 sectionTags
- **变更清单**：
  - **设计文档**：§2 数据模型（删 Lesson、Page 加 courseId+sectionTags、Release snapshotData={pages:[...]}）；§3（扁平结构、TOC、H2 section tags、同步方案 C）；§5 API（删 Lesson 端点、Page 路由改 `/courses/:courseId/pages`）；§4.4.2（读 snapshot.pages）
  - **后端**：`schema.prisma` 删 Lesson、Page 加 `courseId`+`sectionTags Json?`；新迁移 `20261016055712_flatten_course_page`；删 `server/src/lessons/`；Pages/Courses/Sync/Releases/AI 全量适配；`mergeLessonContent` 合并外部 Lesson→Page；`migrateTags` 按 H2 slug 过滤 sectionTags；`ai-chat.service.ts` buildContext 按 H2 切分并拼接 `[TAGS: ...]`（slugify 与 sync/前端一致）；seed 用合并逻辑生成扁平 Page
  - **前端**：`api/knowledge.ts`（删 Lesson 端点、PageNode 加 sectionTags）；`knowledgeStore.ts`（createPage 两参、PageDraft 加 sectionTags、新增 tocScrollTarget/scrollToHeading/clearTocScrollTarget）；`CourseTree.tsx`（Course→Page→Heading 三级树、解析 contentMd 提取 H1/H2/H3、heading 点击 scrollToHeading）；`PageEditor.tsx`（监听 tocScrollTarget 滚动定位、H2 下方 portal 注入 TagManager 编辑 sectionTags）；`UploadDocumentModal.tsx`（目标改 Course）
  - **测试**：releases.service.spec.ts、knowledge.e2e-spec.ts、ai.e2e-spec.ts、files.e2e-spec.ts 适配新结构
- **自测证据**：
  - 后端 `tsc --noEmit`：0 错误；单测 35/35 PASS；e2e 40/40 PASS
  - 前端 `tsc -b --noEmit`：0 错误；`vite build`：✓ built in 1.43s
- **审查结论**：Review Agent **APPROVE**，3 Non-blocking（已主动补齐第 1 条：AI 上下文使用 sectionTags；第 2 条 e2e 覆盖、第 3 条生产数据迁移为后续项）
- **Git**：本地未提交（含上一轮 Figma 基础设施攒批）
- **下一步**：用户手动冒烟（TOC 展开/滚动、H2 section tags 编辑、上传文档建页、发布快照）；确认后推送分支并发 PR

---

## 2026-10-16 ｜ 细节调整第七轮：建立 Figma 设计库迁移基础设施（设计 Token + UI 封装层）

- **任务**：用户有 Figma 设计库但尚未接入，评估当前前端（Ant Design 5.x 全量直接使用、100% 内联样式、硬编码颜色/间距）能否平滑迁移。经评估风险高（无组件封装层、硬编码 token 遍布 12 文件、未用 antd 主题系统），用户拍板先建立迁移基础设施，不改业务逻辑、零视觉变化。
- **用户拍板**：
  - 目标：建立迁移基础设施（封装层 + token），不直接接入 Figma 库
  - 封装全部 20 个 antd 组件（非仅高频），间距/字号也 token 化
  - token 值与既有 antd 默认值一致，零视觉变化
- **变更清单**（仅 client/）：
  - **新增 `theme/tokens.ts`**：颜色/间距/字号/圆角/字重单一来源（color.primary=#1677ff、spacing.xs..2xl=4/8/12/16/24/48、radius.sm/md/lg=6/8/12、fontSize.xs..2xl=10..16、fontWeight.normal/medium/semibold=400/500/600）
  - **新增 `components/ui/` 封装层**（14 文件 + index.ts barrel）：Button/Card/Input/Select/Tag/Modal/Table/Tree/Tabs/Segmented/Avatar/Typography/Layout。业务组件一律 `import from '../ui'`，禁止直接 `import from 'antd'`。封装层纯透传 props，不强制覆盖外观（保持 antd 默认圆角等），未来替换 Figma 组件仅改本层
  - **`App.tsx`**：ConfigProvider theme 注入与 antd 默认一致的 token（colorPrimary/success/warning/error/fontSize），**不**注入 borderRadius/colorBorder/colorText/colorTextSecondary（避免改变 antd 组件内部外观）
  - **12 个业务组件**（layout/knowledge/ai/pages）：import 从 `'antd'` 改为 `'../ui'`；硬编码颜色（#1677ff/#f0f0f0/#52c41a/#faad14/#8c8c8c/#999/#bfbfbf 等）→ `tokens.color.*`；硬编码间距（4/8/12/16/24）→ `tokens.spacing.*`；硬编码字号/圆角/字重 → `tokens.*`
  - **`index.css`**：新增 `:root` CSS 变量（与 tokens.ts 同步），供 BlockNote/md-editor 等第三方库覆盖；`.ai-mode-segmented` 选中色改用 CSS 变量
  - **文档**：§6.1 项目结构更新（新增 theme/、ui/，修正 ai-tutor→ai、补充 UploadDocumentModal/ModuleNav）；新增 UI 抽象层与设计 Token 说明
- **自测证据**：
  - `npx tsc -b --noEmit`：0 错误
  - `npm run build`：✓ built in 1.06s 成功（仅 chunk >500kB 警告，非失败）
  - Grep `from 'antd'`（排除 ui/）：仅 App.tsx 2 处（ConfigProvider + locale），符合例外规则
  - Grep 业务组件 hex 颜色：无硬编码（仅 tokens.ts / index.css 定义处）
- **审查结论**：Review Agent 初审 REQUEST_CHANGES（3 Blocking：ConfigProvider 注入了与 antd 默认不一致的 borderRadius/colorBorder/colorText/colorTextSecondary 导致全局视觉变化；Button/Card 封装层强制 borderRadius=8）；修复后复审 **APPROVE，0 Blocking**
- **Git**：本地 main 攒批未推送
- **下一步**：等用户手动冒烟测试（确认视觉无变化）；Figma 设计库形态确定后，修改 tokens.ts 和 ui/ 封装层即可迁移，业务组件零改动

---

## 2026-10-15 ｜ 细节调整第六轮：AI Tutor 布局改版对齐设计稿 + 版本号去秒

- **任务**：用户提供 AI Tutor 设计稿，要求按设计调整 AI Tutor 板块内容（不动 Knowledge/顶部/左侧导航）：① 顶部栏显示课程标题 + Change Course 下拉 ② 左侧配置重排为 System Prompt → Welcome Message → LLM Model，底部 Reset 链接 + Unsaved changes 提示 + Save Configuration ③ 对话头部显示激活版本号 + Testing 徽章（固定）④ 输入框占位符 "Ask the tutor a question..."、Send 按钮。另：用户发现版本号含秒，确认改为 `YYYYMMDDHHmm`（去秒）
- **用户拍板**：
  - 版本号格式去秒：`YYYYMMDDHHmm`（原 `YYYYMMDDHHmmss`）
  - Testing 徽章固定显示（表示 AI 测试用知识库版本）
  - Change Course 从左侧配置面板移到顶部全宽栏
- **变更清单**：
  - **后端**：
    - `releases.service.ts`：`timestamp()` 去掉 `getSeconds()`，输出 12 位；注释同步
    - `ai-config.service.ts`：`AiConfigView` 增加 `currentReleaseTag`；`ensureCourse` 返回 `{id, currentReleaseId}`；`toView` 改 async 查询激活 Release.versionTag；getConfig/saveConfig/resetConfig 三处调用加 await + 传 currentReleaseId
    - `releases.service.spec.ts`：正则 `\d{14}`→`\d{12}`；mock 数据 versionTag 同步 12 位
  - **前端**：
    - `api/ai.ts`：`AiConfigView` 增加 `currentReleaseTag: string | null`
    - `stores/aiStore.ts`：增加 `initialForm` 快照 + `isDirty()` 方法；selectCourse/setMode/save/reset 四处维护 initialForm 确保模式切换不误报 dirty
    - `pages/AITutor.tsx`：新增顶部栏（课程标题 + Change Course 下拉），主体改为 column flex
    - `components/ai/ConfigPanel.tsx`：移除 Change Course；重排 System Prompt(rows=8,等宽字体) → Welcome Message → LLM Model；底部三栏（Reset 链接 / Unsaved changes / Save Configuration）
    - `components/ai/ChatWindow.tsx`：头部三栏（版本号+Testing 徽章 / Lecture-Socratic / New Chat）；占位符 "Ask the tutor a question..."；按钮 "Send"
  - **文档**：§2/§3.4.1/§3.4.3 版本号去秒；§4.1/§4.2/§4.3 布局改版（§4.3.1 对话头部新增）；§5.2 接口说明加 currentReleaseTag；§4.3.3→§4.3.4 编号修正
  - **其他**：`schema.prisma` versionTag 注释去秒；`review-agent.md` 审查标准版本号格式同步
- **自测证据**：前端 `npx tsc --noEmit` 0 错；后端 `npx tsc --noEmit` 0 错；后端 `npm test` 9 suites / 35 tests 全绿
- **审查结论**：Review Agent 独立审查 **APPROVE，0 Blocking**。3 项 Non-blocking：① schema.prisma versionTag 注释漂移（**已修**）② review-agent.md 格式未同步（**已修**）③ AI 协作日志（本条补）
- **Git**：本地 main 攒批未推送
- **下一步**：用户重启后端（使 currentReleaseTag 生效）+ 前端冒烟验证：顶部栏课程标题/Change Course、配置面板重排与 Unsaved changes 提示、对话头部版本号+Testing 徽章、新版本发布的 versionTag 是否为 12 位（去秒）

---

## 2026-10-15 ｜ 细节调整第五轮：AI Tutor 模型清单扩展 + 布局错位修复 + API Key 课程级覆盖下线

- **任务**：用户针对 AI Tutor 板块提 3 点：① 读取 OpenRouter 可行模型并扩充 LLM Model 下拉（仅热门+免费额度，挑 8 个，必须含 deepseek flash 作测试）② AI Tutor 配置面板位置错位（应在 Knowledge/AI Tutor 导航栏右侧而非下方）③ 移除 API Key 课程级覆盖输入块（已配全局 OPENROUTER_API_KEY）
- **用户拍板**：
  - ① 8 模型清单：`deepseek/deepseek-v4.1-flash`（默认，测试用）、`deepseek/deepseek-r1`、`openai/gpt-4o-mini`、`anthropic/claude-haiku-5.5`、`google/gemini-3.5-flash`、`qwen/qwen3.6-flash`、`google/gemma-4-31b-it:free`、`nvidia/nemotron-3-super-120b-a12b:free`；所选模型即该课程对话用模型（测试+学生端）
  - ② 布局修复方案：`MainLayout` 内层 `<Layout>` 加 `style={{ flexDirection: 'row' }}`（AntD Layout 无 Sider 时默认 column，导致 ModuleNav 与 Content 垂直堆叠）
  - ③ 仅移除前端 UI，保留后端 `CourseAiConfig.apiKey` 字段与加密逻辑（最小改动、未来可恢复）
  - 新增通用规则：「有问题先提问，跟用户沟通确认后再下决定」→ 写入 `.trae/rules/project_rules.md`
- **变更清单**：
  - `server/.env` + `server/.env.example`：`AI_AVAILABLE_MODELS` 扩充为 8 模型，deepseek-v4.1-flash 居首（后端 `defaultModel()` 取列表第一个）
  - `client/src/components/layout/MainLayout.tsx`：内层 Layout 加 `flexDirection: 'row'`
  - `client/src/components/ai/ConfigPanel.tsx`：移除 API Key Form.Item（含清除按钮）+ Tag import，更新顶部注释
  - `client/src/stores/aiStore.ts`：AiForm 移除 `apiKeyInput`/`clearApiKey`；save/reset/selectCourse 中相关逻辑清理
  - `client/src/api/ai.ts`：saveConfig 入参类型移除 `apiKey?`
  - 设计文档 §4.2.3（默认模型/用途/API Key 下线说明）+ §8 env 示例同步 8 模型
  - `.trae/rules/project_rules.md`：「用户裁决优先」节新增第 3 条规则
- **自测证据**：前端 `npx tsc --noEmit` 0 错；后端 `npx tsc --noEmit` 0 错；后端 `npm test` 9 suites / 35 tests 全绿
- **审查结论**：Review Agent 独立审查 **APPROVE，0 Blocking**。2 项 Non-blocking：① 文档 §8 示例漂移（**已当场修**：同步为 8 模型）② 前端 `hasApiKey` 字段无组件消费（保留，后端仍返回、留作未来 UI 提示）
- **Git**：本地 main 攒批未推送（与 bf4ef55 等一起，待用户冒烟后统一推分支/PR）
- **下一步**：用户重启后端（使新 AI_AVAILABLE_MODELS 生效）+ 前端冒烟验证：① LLM Model 下拉是否显示 8 个模型、默认是否为 deepseek-v4.1-flash ② AI Tutor 配置面板是否在导航栏右侧横向排列 ③ API Key 块是否已移除、Save 是否正常

---

## 2026-10-15 ｜ 细节调整第四轮：Markdown 编辑器改 BlockNote 块编辑器（§3.3.2）

- **任务**：§3.3.2 编辑器选型由 `@uiw/react-md-editor` 全文编辑改为 **BlockNote**（用户拍板 Notion/Jupyter 式）；存储不变（`Page.contentMd` 唯一事实来源，`blocksToMarkdownLossy` 序列化），源码模式保留兜底
- **用户拍板**：输入=源码快捷语法、失焦/切块自动保存渲染；拖拽重排启用；模式切换按钮放 Tags 左侧；右键菜单插入块 + 选中浮窗；图片本轮仅外链 URL
- **实现要点**：
  - 依赖：`@blocknote/react@0.56.0` + `@blocknote/math-block@0.56.0` + `@blocknote/core@0.56.0`（注意：`BlockNoteView` 实际导出名是 `BlockNoteViewRaw`；数学包是 `@blocknote/math-block` 而非不存在的 `@blocknote/math`）
  - Schema：`BlockNoteSchema.create` 扩展 `mathBlock` 块 + `math` 行内内容；`SuggestionMenuController` 注入默认 + `getMathSlashMenuItems`
  - 数据往返：`tryParseMarkdownToBlocks` 加载 / `blocksToMarkdownLossy` 保存；`lastLoadedMd` ref 防源码↔块模式切换数据丢失；`loadingRef` + rAF 屏蔽加载期 onChange
  - 右键插入：AntD `Dropdown` trigger contextMenu + `getTextCursorPosition` + `insertBlocks(after)`；标题映射 `heading1/2/3 → heading + props.level`
  - 选中浮窗：BlockNote 原生 `formattingToolbar`（粗体/斜体/下划线/删除线/行内代码/链接/高亮）
  - 图片：`uploadFile` prompt 索取外链 URL，slash 菜单与右键入口一致
- **已知限制（下轮补）**：选中浮窗「转公式」按钮未实现（需 ProseMirror 级选区替换为 math 行内内容）；当前可通过 `$…$` 语法或 `/` 斜杠菜单插入公式
- **自测证据**：client `tsc -b` 0 错、`vite build` 成功（chunk 3.6MB 为 BlockNote+KaTeX 体积，正常）；后端单测 35/35、e2e 44/44（无变更）
- **审查结论**：首轮 REQUEST_CHANGES（2 Blocking：标题块类型 heading1/2/3 错误、源码→块模式数据丢失）+ 6 Non-blocking；修复后复审 **APPROVE（0 Blocking）**。Non-blocking 中 5 项已修（双重防抖、降级提示、加载期屏蔽保存、空结果降级、图片双轨），N2 转公式按钮留作已知限制
- **Git**：用户拍板本地提交 main 攒批（与 c5958b5/0be4959/e89ff21 一起，冒烟反馈修完后统一推分支/PR）
- **下一步**：用户重启前端冒烟（块编辑/数学/拖拽/右键/模式切换/上传 md 自动加载）→ 反馈修复；N2 转公式按钮下轮补全

---

## 2026-10-15 ｜ 细节调整第三轮：树格式修正 + 上传改两步弹窗（Upload and Parse）+ 编辑器块化拍板 BlockNote 方向

- **任务**：用户手动冒烟第二轮后反馈 3 点：① 课程名应顶栏最左（`visibility:hidden` 仍占位留白）、图标与标题换行错位需修 ② 上传按设计稿改两步弹窗（选文件→转换预览→Import 建页）③ md 编辑器块化（Notion/Jupyter 式）——第 ③ 点仅讨论拍方向，不动代码
- **用户拍板**：
  - ① 方案经确认执行：树 `display:none` 去占位+行内自绘图标+indent 16px；接口拆为 `POST /api/files/convert`（仅转换返回 `{title, markdown}` 不建页），Import 复用 §5.1.3 建页；弹窗文案按实际白名单 8 格式（设计稿中 xls/doc/epub/ppt 不支持）；预览区显示原始 md 文本（与设计稿一致）
  - ③ 编辑器块化技术路线=**BlockNote**（用户调研建议+我方案对齐确认）：存储仍 `contentMd` 单一事实来源（`tryParseMarkdownToBlocks` 加载 / `blocksToMarkdownLossy` 保存，不动表结构）；保留「源码模式」兜底防 fidelity 损失；图片上传端点为待设计项。本轮无代码
- **变更清单**：
  - **设计文档先行同步**：§3.2.1（display:none+行内图标+16px indent）、§3.2.3 重写两步弹窗流程、§5.1.6（upload→convert、原端点废弃注记）、§10.2 流程 7 步、§8 env 示例白名单笔误修正（Review 设计偏差上报项）
  - **后端**：`files.service.ts` `uploadAndCreatePage`→`convertFile`（去 PagesService 依赖，白名单/15MB/空结果/busboy latin1 乱码修复全保留）；`files.controller.ts` `POST /files/convert`（无 lessonId）；`files.module.ts` 去 PagesModule import；`pages.module.ts` 回退 exports；删 `dto/upload-file.dto.ts`；spec 5 用例、e2e 6 用例改写（含 convert 不建页计数断言 + 两步完整流程落库校验）
  - **前端**：`api/knowledge.ts`（uploadFile→convertFile+ConvertedDocument）；`knowledgeStore.ts`（uploadDocument→importDocument）；新组件 `UploadDocumentModal.tsx`（Dragger 预校验→Next 转换→预览→Import；代际号防关闭竞态）；`CourseTree.tsx`（去 showIcon/隐藏 input，行内图标+标题 ellipsis，菜单项开弹窗）；`index.css`（switcher display:none、indent-unit 16px）
- **自测证据**：server `tsc --noEmit` 0 错、client `tsc -b` 0 错；单测 9 套件 **35/35**；e2e 4 套件 **44/44**（files e2e 6 用例：convert 返回不建页、两步流程建页落库、.exe 400、无 file 400、15MB+1→400、信封脱敏）。冒烟由用户手动执行
- **审查结论**：Review Agent 独立审查 **APPROVE，0 Blocking**。6 项 Non-blocking：#1 转换中关闭弹窗竞态（**已当场修**：genRef 代际号丢弃 in-flight 结果）、#2 onRemove 死代码（**已当场修**：删除）、#3 步骤②无返回按钮（UX 备忘）、#4 本日志（已补）、#5 convert 无速率限制（沿用遗留，§9.4 口径待用户裁决）；另 §8 白名单笔误（设计偏差上报）**已回填**
- **Git**：用户拍板本地提交 main 攒批（与 c5958b5/0be4959 一起，冒烟反馈修完后统一推分支/PR）
- **下一步**：用户重启前后端手动冒烟（树对齐、两步弹窗上传真实 docx/pdf、Import 建页）→ 反馈修复；第 ③ 点出 BlockNote 详细设计稿（交互细节+md fidelity 映射表+图片上传方案）供拍板

---

## 2026-10-15 ｜ 细节调整第二轮：Knowledge 左侧面板（目标过滤 + 去锁 + 点击展开 + 文档上传）

- **任务**：用户附截图反馈 Knowledge 面板 4 点调整：① 课程树按同步目标过滤（选 Calculus Fundamentals 只显示其 lessons，不混显 Population Growth）② 移除同步目标上锁/解锁功能 ③ 点击课程名下拉 lessons、隐藏原生箭头并另设提示 ④ 实现此前未落地的文档上传功能
- **用户拍板**：
  - ① 转换引擎=**markitdown-ts 本地转换**（内存 Buffer 直转、不落盘、不调外部服务；§12 事项 #3 落文）
  - ② 上传落地=**指定 Lesson 下新建 Page**，标题=文件名去扩展名，新页 syncState=SYNCED
  - ③ 切换同步目标=先 flushSave 再清空编辑器，之后恢复该课程**上次编辑页**（lastPageIdByCourse 记忆）
  - ④ 白名单按 markitdown-ts 实测支持面调整：**.txt/.md/.csv/.pdf/.docx/.xlsx/.html/.xml**（xls/doc/ppt/epub 不支持，原 §10.1 清单勘误）
  - ⑤ 展开提示方案=CSS 隐藏 `.ant-tree-switcher` + 行尾 chevron（收起▸/展开▾旋转）
- **变更清单**：
  - **设计文档先行同步**：§3.2.1（树过滤+隐藏箭头+chevron）、§3.2.2（无锁常驻下拉+flushSave+上次编辑页）、**新增 §3.2.3**（上传流程：预校验→multipart file+lessonId→白名单/15MB 二次校验→本地转换→建页）、§5.1.6（POST /api/files/upload）、§10.1/10.2/10.3、§12 #3 拍板落文
  - **后端**：新增 `src/files/`（module/controller/service/dto）——FileInterceptor memoryStorage + `limits:{fileSize:15MB, files:1}`；`markitdown.convertBuffer(buffer,{file_extension:'.docx'})`（**扩展名必须带点**，实测教训）；复用 PagesService 建页（pages.module 加 exports）；转换失败原始错误仅 logger.warn 不外泄；`fixFilenameEncoding` 修复 busboy 按 latin1 解析 multipart 中文文件名乱码；`all-exceptions.filter.ts` 增 413→400 映射（Nest `transformException` 先把全部 MulterError 转 PayloadTooLargeException，原 MulterError 分支为死代码已删，Review 核实成立）；app.module 注册 FilesModule
  - **前端**：`api/knowledge.ts`（uploadFile FormData 封装 timeout 60s、白名单/上限常量与后端逐字一致）；`knowledgeStore.ts`（删 externalLocked/unlockExternal 全仓无残留、selectExternal 改 async、lastPageIdByCourse、uploadDocument 动作）；`Sidebar.tsx`（锁卡片 UI 移除、常驻 Select）；`CourseTree.tsx`（visibleCourseId 过滤、行点击 toggleRow 展开、chevron、Lesson 菜单「上传文档建页」+前端预校验、双分支空态）；`SyncButtons.tsx` 去锁依赖；`index.css` 加 `.course-tree-no-switcher`
  - **依赖**：server +`markitdown-ts`、+`@types/multer`（devDep）
- **自测证据**：server `tsc --noEmit` 0 错误、client `tsc -b` 0 错误；单测 9 套件 **35/35**（新增 files 5 用例：md 真实转换建页、.exe/.epub 400、空 buffer/无扩展名 400、转换结果空 400、latin1 乱码文件名还原）；e2e 4 套件 **46/46**（新增 files 8 用例：md 上传 201+落库校验、.exe 400、缺 lessonId 400、非法 UUID 400、lesson 不存在 404、无 file 字段 400、15MB+1→400「文件大小超过 15MB 限制」、错误信封不泄露堆栈）；开发前真实样本实测：docx 6799 字符、pdf 1567 字符转换成功。冒烟按口径由用户手动执行
- **审查结论**：Review Agent 独立审查（新上下文）首轮即 **APPROVE，0 Blocking**。9 项 Non-blocking 留档：#1 selectExternal 在 flushSave 失败时仍清空草稿（网络异常可静默丢草稿）、#2 快速连续切换目标竞态（await 后未复查当前目标）、#3 toggleRow 在 setState updater 内调 store 副作用（StrictMode 双调用抖动）、#4 上传端点无速率限制（§9.4 泛化要求，口径需用户裁决）、#5 413→400 映射全局生效（当前仅 files 端点产生 413，无实际影响）、#6 过滤器 413 分支无直接单测（e2e 已覆盖端到端）、#7 无扩展名文件前端预校验提示文案（"Makefile"→提示「格式暂不支持：e」）、#8 §3.2.1 chevron 措辞仅提课程行（实现同样用于章节行，下轮文档回填顺带补）、#9 本日志条目（已补）
- **Git**：用户拍板不建分支，本地提交 main（与上轮 c5958b5 攒批，未推送；冒烟反馈修完后统一推分支/PR）
- **下一步**：用户重启后端手动冒烟四项（切换目标树过滤、点击展开交互、真实 docx/pdf 上传建页、去锁后同步按钮行为）→ 反馈修复 → 攒批推送分支

---

## 2026-10-15 ｜ 细节调整：Publish 激活版本模型（历史版本可切换 + AI 知识源改读快照）

- **任务**：用户手动冒烟 Phase 4/5/6 后反馈 Knowledge 流程差距（4 点梳理），本轮实现其中第 4 点：Publish = ①浏览历史并切换 ②发布后 AI Tutor 以该版为知识库、草稿同步变为该版可编辑版
- **用户拍板**：
  - ① AI Tutor 知识源=**读激活 Release 快照**（不再读实时草稿；未发布课程 chat-stream 报 400 提示先 Publish）
  - ② 切换历史版本=**覆盖草稿**（二次确认弹窗明示不可撤销）
  - ③ 外部源音视频数据**本轮不处理**（留 §12 事项 #4 真实 API 接入时一并设计）
  - ④ Publish 表格 Revision Notes 列语义=**激活版本的备注**（Review 设计偏差上报，用户裁决改文档不改实现）
  - ⑤ 协作规则（长期有效）：每次大迭代完成后**先询问用户**是否推送新分支用于合并；`.env` 缺失 4 项（PORT/NODE_ENV/AUTH_ENABLED/AUTH_TOKEN）不补全，依赖代码默认值；OPENROUTER_API_KEY 由用户自行填写，AI 不经手密钥值
  - ⑥ AI_AVAILABLE_MODELS 改为仅 `deepseek/deepseek-v4.1-flash`（经 OpenRouter /models 公开接口核查 462 模型确认存在；不加 AI_MOCK 开关，key 留空即天然安全验证态）
- **变更清单**：
  - **设计文档先行同步**：§2 Course 增 `currentReleaseId String?`（普通标量列不建外键）；§3.4.1 列语义；§3.4.2 历史版本可切换（激活中标识+二次确认+事务重建草稿树）；§3.4.3 发布即激活、快照仅含 SYNCED 节点；§4.3.3 AI 知识源改读激活快照；§5.1.4 增 `POST /api/courses/:id/activate-release`、releases 列表带 isActive；§12 事项 #5 标记已拍板
  - **Schema/迁移**：`20261015030120_add_course_current_release_id`（ALTER TABLE 可空列）
  - **后端**：`releases.service.ts` publish 单事务（读取→快照→激活指针，Review Blocking 修复项）、新增 activate（事务内 deleteMany+按快照重建 Lesson/Page、一律 SYNCED、更新指针、归属校验 404）、findAllByCourse 标注 isActive；`releases.controller.ts` 新路由；`dto/activate-release.dto.ts`；`ai-chat.service.ts` buildContext 改读激活快照（未发布 400）
  - **前端**：`api/knowledge.ts`（ReleaseSummary.isActive、ReleaseDetail 改 Omit+可选、activateRelease 封装）；`knowledgeStore.ts` 新增 afterActivateRelease（清防抖定时器+丢弃草稿+刷新树，防旧草稿写回已覆盖的树）；`PublishPanel.tsx`（Current Version/Revision Notes 列改按激活版本渲染、历史 Modal「激活中」绿标+「切换到此版本」danger 二次确认）
- **自测证据**：server `tsc --noEmit` 0 错误；单测 8 套件 **30/30**（含发布即激活、事务内 SYNCED 过滤断言、activate 重建/归属 404、isActive 标注）；e2e 3 套件 **38/38**（新增 activate 端到端切版本重建草稿树+新 ID 回写、未发布课程 400、限流夹具前置发布；ai 夹具 afterAll 补删 Release 防外键）；空库重放：临时库 `migrate deploy` 3 迁移全部成功（验证后已删）；client `tsc -b` 0 错误。冒烟按新口径由用户手动执行
- **审查结论**：Review Agent 独立审查首轮 **REQUEST_CHANGES**（1 Blocking：publish 快照读取在事务外，违反 §3.4.3「单事务」；修复移入 $transaction 后复审 **APPROVE**）。Non-blocking 处置：#2 ReleaseDetail.isActive 类型已修、#3 §3.4.1 措辞经用户裁决已修；留档后续：#4 activate N+1 可改 createMany、#5 边界用例补充（空 releaseId 400/courseId 404/全 STALE 空快照）、#6 悬空指针 400 提示语义；已知限制：快照不含 duration，切换版本后章节时长丢失（当前无功能消费，若启用先改文档 §2 快照结构）
- **Git**：用户拍板不建分支，本地提交 main `c5958b5`（ahead 1，未推送；后续攒调整一起推）
- **下一步**：用户重启后端后手动冒烟（发布→编辑→切历史版本→AI 对话验证知识源为激活版）→ 反馈修复 → Phase 7 剩余项

---

## 2026-10-14 ｜ Phase 4/5/6 完成：Knowledge UI + 外部同步重设计 + AI Tutor 前后端

- **任务**：开发文档 §7 Phase 4（Knowledge System 前端）、Phase 5（AI Tutor 后端）、Phase 6（AI Tutor 前端），用户指示一次性完成 5/6
- **用户拍板**：
  - ① 测试口径（长期有效）：**AI 不做任何冒烟测试**，仅代码测试/接口测试；冒烟由用户手动测试（要符合其需求）；先完成所有阶段再回头微调（微调归 Phase 7）
  - ② AI Provider = **OpenRouter**（用户持 key，含多模型，具体可用模型清单后续确认；接口按 OpenAI 兼容实现）
  - ③ 对话持久化 = **不落库**：New Chat 清空；短时退出再进保留上次聊天（localStorage 按 courseId+mode 隔离）；无长期记忆需求
  - ④ 同意新增 env 加密密钥 `AI_CONFIG_ENCRYPTION_KEY`（AES-256-GCM，64 位 hex）
  - ⑤ 外部同步重设计（Phase 4 内）：非破坏性幂等同步 + 同步前选择器锁定目标外部课程 + STALE 置灰不删除本地数据
- **变更清单**：
  - **Phase 4 前端**（client/src/）：MainLayout/Sidebar/Header、CourseTree（STALE 置灰斜体+Tooltip）、SearchBox、SyncButtons（接同步摘要、未锁定禁用）、PageEditor（@uiw/react-md-editor 4.1.2 + remarkMath + rehypeKatex，500ms 防抖）、TagManager、PublishPanel（发布/历史版本回放）、api/client.ts + api/knowledge.ts + stores/knowledgeStore.ts；清理 Phase 1 脚手架残留
  - **Phase 4 同步后端**（server/src/sync/）：新增 3 接口 GET /api/sync/external-courses（带同步状态）、POST /api/sync/structure、POST /api/sync/all；非破坏性幂等算法（事务、新增/STALE 标记/STALE 恢复/标题冲突处理、绝不覆盖用户已编辑 contentMd）；内存 fixture `demo-fixtures.ts`；Prisma migration `20261014113129_add_sync_state`（enum+两列 DEFAULT SYNCED）；`seed-demo.ts`（4 课程含公式/表格/标签，幂等）
  - **Phase 5 后端**（server/src/ai/，9 源文件）：LlmProvider 策略接口 + ProviderRegistry + OpenRouter 适配器（原生 fetch 解析 SSE，零厂商 SDK）；CryptoService（AES-256-GCM，`iv:tag:ciphertext` hex）；AiConfigService（CRUD 视图仅 `hasApiKey` 绝无 apiKey 字段；resolvePrompts custom>课程模板>isDefault；resolveRuntime 课程级解密兜底 env）；AiChatService（限流→Prompt 组装：System+SOCRATIC 固定引导语+`[CONTEXT_START]` 仅 SYNCED Lesson/Page `[CONTEXT_END]`+history≤10；首字节前重试≤2）；RateLimitService（内存滑动窗口 10 次/分钟/courseId，超限 429）；chat-stream SSE 豁免（先 `await gen.next()` 使限流/404 走全局过滤器 JSON，流中途失败下发 error 帧）；`.env.example` 补 4 个 AI 变量
  - **Phase 6 前端**（client/src/）：api/ai.ts（fetch+ReadableStream 按 `\n\n` 分帧解析 SSE，非 2xx 解析信封抛错）、stores/aiStore.ts（localStorage 会话 `aitutor.chat.${courseId}.${mode}`、effectivePrompts 与后端同口径）、ConfigPanel（课程/模型/API Key 脱敏编辑+清除/System Prompt/Welcome/Reset/Save）、ChatWindow（LECTURE/SOCRATIC 切换、New Chat、流式渲染经 `MDEditor.Markdown`+KaTeX——React 19 下 react-markdown 类型冲突不可直接 import）、pages/AITutor.tsx
  - **设计文档同步（先行回填）**：§3.1/§3.2.2（同步接口与 Mock 口径）/§4.3.2/§4.3.3/§4.4.1/§4.4.2/§5.2/§8/§12 #2 #6/Phase 5 步骤；README、agents/dev-agent.md
- **自测证据**（按新口径，无浏览器冒烟）：`npm run build`（server）✅；单测 8 套件 28 用例 ✅（crypto 随机 IV/篡改/坏密钥、rate-limit 第 11 次/课程隔离/窗口滑出等）；e2e 3 套件 35 用例 ✅（app 4 + knowledge 21 + ai 10；假 Provider 零触网；断言 prompt 组装/STALE 排除/限流 429/响应与 DB 双端脱敏/同步幂等）；`npm run build`（client）✅（bundle 2.48MB，chunk 警告留 Phase 7）
- **审查结论**：Review Agent 独立审查首轮 **REQUEST_CHANGES**（2 Blocking 均为文档侧：B1 §3.2.2 响应多写 `updated` 字段、B2 fixture 路径误写 `external-source.ts`），当场修复后复审 **APPROVE**。9 项 Non-blocking 留后续迭代：OpenRouter 死三元、错误消息内部细节、buildContext 钩子注释、同步并发唯一约束、章级 STALE 恢复对称性、流式中禁用课程/模式切换、ConfigPanel 保存失败提示、chunk 拆分、e2e 命令勘误（正确入口 `npm run test:e2e`）
- **Git**：`feature/phase4-knowledge-ui` 推送；PR #4 建立并代合入 main
- **环境待办（用户侧）**：`server/.env` 的 `OPENROUTER_API_KEY=` 留空待填真实 key；`AI_CONFIG_ENCRYPTION_KEY` 已随机生成写入；后端进程此前被终止，需 `cd server; npm run start:dev` 重启后手动冒烟（前端 `cd client; npm run dev`，http://localhost:5173）
- **下一步**：用户手动冒烟 Phase 4/5/6（Knowledge UI、同步 5 场景、AI Tutor 对话/配置）→ 反馈问题修复 → Phase 7（微调、完整认证、Non-blocking 项收口、§12 剩余事项）

---

## 2026-10-14 ｜ Phase 3 完成：Knowledge System 后端

- **任务**：开发文档 §7 Phase 3（Course/Lesson/Page CRUD、Release/Publish、Sync Mock、接口鉴权基础版，共 §5.1 全部 18 端点）
- **前置核验**：用户要求独立复核 Phase 1/2 完成情况——git 历史（PR #1/#2 均合入）、prisma validate、build、10 单测 + e2e、数据库 8 表 + `_CourseToUser` + 迁移 + seed 2 行、client build（antd 5.x）全部通过，确认无误后开工
- **用户拍板**：① 鉴权=**仅预留骨架**（`ApiKeyGuard` 全局注册，`AUTH_ENABLED` 默认 false 不拦截；开启后校验 `X-API-Key == AUTH_TOKEN`，不符 401；完整认证 Phase 7 定，对应 §12 事项 #1）② 删除保护=**Course 存在 Release 历史时拒删 409 CONFLICT**（级联仅 Lesson/Page）
- **变更清单**（均在 server/，除文档）：
  - 新增 `src/courses|lessons|pages|releases|sync` 五模块：18 端点 + class-validator DTO（Create/Update/Reorder）；sortOrder 缺省自动追加末尾；Release 快照 versionTag=`CourseName_YYYYMMDDHHmmss`、snapshotData 全量固化、历史列表 select 排除 snapshotData；Sync 两端点返回 Mock 假数据
  - 新增 `src/common/app-setup.ts`：全局 `/api` 前缀 + ValidationPipe(whitelist/transform)，main.ts 与 e2e 共用
  - 新增 `src/common/guards/api-key.guard.ts`：鉴权骨架（口径见上）；`.env.example` 补 AUTH_ENABLED/AUTH_TOKEN 占位
  - 依赖：新增 class-validator/class-transformer；**@nestjs/mapped-types 锁 2.1.1**（npm latest 12.0.0 为 ESM-only，jest CJS 管线不兼容，实测后降级；2.0.6 因 peer 仅支持 Nest≤10 不可用）
  - 设计文档同步：§5.1.1 删除保护注记、§7 Phase 3 鉴权口径注记、§12 事项 #1 拍板落文
  - 测试：新增 3 单测套件（courses 删除保护/404、releases 快照结构/versionTag、guard 开关语义）+ `test/knowledge.e2e-spec.ts` 全流程 22 用例（真实库自建自清，E2E- 前缀 afterAll 清理）
- **自测证据**：`npm run build` ✅；单测 6 套件 22 用例 ✅；e2e 2 套件 23 用例 ✅（含 400 校验、404 无泄露、409 删除保护、快照回放）；`node dist/main` 冒烟 GET /api/courses 返回 §5.3 信封 ✅
- **审查结论**：Review Agent 独立审查 **APPROVE，无 Blocking**。Non-blocking：#1（PUT /api/courses 缺 e2e）#5（^ 写法与"锁 2.1.1"口径不符）已当场修复（commit 475f683，e2e 增至 23 用例）；#2（删除三步非事务 TOCTOU）#3（token 非常数时间比较）#4（versionTag 本地时区）单用户本地部署可接受，**留待 Phase 7 完整认证时一并处理**
- **Git**：`feature/phase3-knowledge-api`（129d241 + 475f683）推送；PR #3 建立并代合入 main（679550f）：https://github.com/Crescent-MJ/KnowledgeSystem/pull/3
- **下一步**：Phase 4 Knowledge System 前端（MainLayout/CourseTree/PageEditor md-editor-v3+KaTeX/TagManager/PublishPanel/Sync 按钮，对接本轮 API；顺带清理 Phase 1 遗留 client 脚手架残留文件）

---

## 2026-10-14 ｜ Phase 2 完成：NestJS 后端基础

- **任务**：开发文档 §7 Phase 2（TS 编译环境、Prisma 客户端单例、统一响应格式中间件、错误处理中间件、环境变量配置）
- **用户拍板**：PR #1 由主智能体代合（已合入 main fc886ec）；§8「项目根目录 .env」措辞更正为 `server/.env`；Review Non-blocking 项修复授权
- **变更清单**（均在 server/，除文档）：
  - `tsconfig.json` 完整 `"strict": true`（上期延后项落实）；`tsconfig.build.json` exclude prisma（修复 start:prod 产物路径，上期遗留缺陷）
  - 新增 `src/prisma/`：PrismaService 单例（OnModuleInit/Destroy）+ @Global PrismaModule
  - 新增 `src/config/env.validation.ts` + `@nestjs/config ^4.0.4`（v12 ESM-only 与 Nest 11 CJS 不兼容，Review 核实成立）：isGlobal、缺 DATABASE_URL 启动即失败
  - 新增 `src/common/`：TransformInterceptor（§5.3 成功信封，SSE 豁免点注释）、AllExceptionsFilter（状态码/Prisma 错误映射，响应体无堆栈/SQL/路径）、api-response 接口
  - 更新 main.ts（PORT 经 ConfigService）、app.module.ts、e2e 断言信封；`.env.example` 补 PORT/NODE_ENV 占位
  - 开发文档 §8 措辞更正（server/.env）
- **自测证据**：`npm run build` ✅；单测 3 套件 10 用例 ✅；e2e 1 用例 ✅；GET / 返回 `{"success":true,"data":"Hello World!","error":null,"message":"操作成功"}`；GET 未知路由 404 信封无泄露；`node dist/main`（start:prod）冒烟 ✅（测后端口已释放）
- **审查结论**：Review Agent 独立审查 **APPROVE**（无 Blocking）。Non-blocking #1（start:prod）#3（envFilePath 注释）已修；#2（本日志条目）即本条；设计偏差 §8 措辞经用户批准更正
- **Git**：`feature/phase2-backend-base` 推送，PR #2 建立并代合入 main
- **下一步**：Phase 3 Knowledge System 后端（Course/Lesson/Page CRUD、Release/Publish、Sync Mock、基础鉴权）；开工前按 §12 确认用户认证口径

---

## 2026-10-14 ｜ Phase 1 完成：server/client 骨架与 PostgreSQL 环境

- **任务**：开发文档 §7 Phase 1（初始化 server/ 与 client/、配置 PostgreSQL、Prisma 建模与 Seed）
- **用户拍板**：后端 NestJS；状态管理 Zustand（全局）+ React Context（少量轻量配置）；PostgreSQL 本机安装、账号/密码均 admin；antd 由 6.6.6 降级 5.x；§2 Schema 双向关系修正 1/2a/3 批准回填（User↔Course 多对多方案 a）；Prisma 实装锁 6.x
- **变更清单**：
  - 新增 `server/`：NestJS 11 + Prisma 6.19.3，schema 按 §2 建 8 表，迁移 `20261014083707_init`，幂等 seed（lecture-default / socratic-default），`.env.example` 占位符
  - 新增 `client/`：Vite + React 19 + TS + Ant Design 5.x + Zustand 最小骨架（ConfigProvider zhCN + 占位标题；stores/api 空目录占位）
  - 修改 `docs/Learning_Guide_BackOffice_Agent_Development_Document.md`：版本信息表/Phase 2/§6.2 拍板落文；§2 Schema 双向关系回填 + Prisma 6.x 注记；联接表名事实更正 `_CourseToUser`
  - 修改 `README.md`（技术栈表 + 启动说明）、`agents/dev-agent.md`（技术约束同步）
- **自测证据**：空库迁移成功；seed 执行两次仍 2 行（幂等）；:3000 与 :5173 均 HTTP 200（测后关闭）；`prisma validate` + 双端 build 通过
- **审查结论**：Review Agent 独立审查 **APPROVE**（无 Blocking）。Non-blocking 处理：联接表名更正、README 回填已修；延后：tsconfig 完整 strict（Phase 2 动工前补）、client 脚手架残留清理（Phase 4）、统一响应格式（Phase 2）
- **Git**：`feature/phase1-init`（05482a3）已推送；PR #1 已建（https://github.com/Crescent-MJ/KnowledgeSystem/pull/1）
- **下一步**：Phase 2 后端基础（Prisma 单例、统一响应格式中间件、错误处理中间件、环境变量配置、tsconfig strict）

---

## 2026-10-14 ｜ 重大决策：项目推倒重来，开发基准切换为 Learning Guide BackOffice

- **任务**：KnowledgeSystem 仓库大更新——废弃旧 AI Tutor 运行时路线，转向 Learning Guide BackOffice（结构化课程知识库管理系统）
- **用户拍板**：① 全程依照 `docs/Learning_Guide_BackOffice_Agent_Development_Document.md`；② 旧文档 `AI_Tutor_Runtime_Design_Spec.md`、`Development_Plan.md` 删除；③ Docker 板块仅删相关内容（§11.2 示例、§11.1 容器化行、Phase 7 部署条目，保留 PostgreSQL/Nginx/PM2）；④ 后端 Node.js、框架待定（后于 Phase 1 拍板 NestJS）；⑤ 目录结构 server/ + client/（不采用 Monorepo）；⑥ 所有方案性建议须经用户同意
- **变更清单**：删除 2 个旧设计文档；开发文档移除 Docker + Phase 1 目录拍板落文；重写 `agents/dev-agent.md`、`agents/review-agent.md`、`.trae/rules/project_rules.md`（新增「用户裁决优先」「变更同步纪律」）、`README.md`；.gitignore 补 .env/node_modules 防护
- **验证**：grep 确认无 Docker/Monorepo 残留；仓库最终 6 文件
- **Git**：main 提交 `0a76321` 已推送（直连被重置，走代理 127.0.0.1:18081 成功）
- **下一步**：Phase 1（已完成，见上条）

---

## 2026-10-22 ~ BackOffice Portal P0 首个版本（Next.js 全新应用）

- **任务**：按 `docs/Learning_Guide_BackOffice_Portal_PRD_v1_1_EN_UK.md` 全新开发 BackOffice Portal P0，覆盖登录、激活、忘记/重置/改密、全局导航、员工账号管理、Bootstrap Admin、RBAC 与中英双语
- **用户拍板**：① 分支 `feature/backoffice-portal`；② 新应用目录 `backoffice/`；③ 技术栈 Next.js 15 App Router + React 19 + TS strict + PostgreSQL(pg)；④ `client/`、`server/` 一律不改（"不要改纯 node.js 的"按最保守处理）；⑤ 实现基准文档新建 `docs/BackOffice_Portal_Implementation.md`；⑥ 暂时忽略 Figma，按 PRD 原型图描述实现
- **变更清单**：
  - 新增 `backoffice/`：Next.js 应用（页面 + API 同仓），含 `components/`、`contracts/`、`modules/`、`repositories/`、`db/migrations/`、`messages/`、`lib/`、`scripts/`、`tests/`
  - 新增 `docs/BackOffice_Portal_Implementation.md`：范围映射、分层边界、规则落点、已知限制、验收步骤
  - 新增 `backoffice/db/migrations/0001_backoffice_portal.sql`：employees / employee_sessions / verification_tokens / audit_events / employee_ui_preferences + bootstrap 保护触发器
  - 修改 `.gitignore`：补 `.next/`、`out/`、`next-env.d.ts`
- **关键决策**：
  - 数据库迁移采用 `db/migrations/*.sql` 顺序执行（与 Next.js + pg 栈一致）；Admin 旧规则里的 Prisma Migrate 仅适用于既有 `server/`，差异记录在实现基准 §2.1；若领导要求改 Prisma，只需重做 `repositories/` + `db/` 两层
  - 密码哈希用 `node:crypto` scrypt（每账号独立盐），零外部依赖
  - 会话令牌与一次性令牌落库只存 HMAC；一次性令牌用条件更新实现"并发只有一个成功"
  - 忘记密码对外返回一致结果，避免账号枚举
  - 邮件投递未配置 provider 时返回 `NOT_CONFIGURED`，不把未投递报成成功
- **Figma 相关结论（供后续复用）**：
  - 官方 Remote MCP 已在 Cursor 连接成功（`Local: Connected`，43 tools / 122 resources）
  - 但 agent 会话拿不到 figma 工具 schema，真实调用返回 `ToolUnavailable: the figma MCP server exposes 0 tools to this agent turn`（见 `docs/design/674-1186.metadata.error.json`）
  - 同机 Origin MCP 的 32 个工具同样缺失，判定为 Cursor 侧工具注入问题，与文件权限无关
  - 另一限制：本环境无法读取磁盘 `.png`（`Read` 报 `.png file not supported`），但**对话中粘贴的截图可以读取**
  - 可行替代：① Figma REST API + PAT（返回纯 JSON，可完整解析）；② 用户截图贴进对话
- **自测证据**：`npx tsc --noEmit` 通过；`npm run lint` 0 warning；`npm run test:unit` 19/19 通过；`npm run build` 成功（22 条路由）
- **待办**：`docs/design/*.json` 为排障产物，交付前清理或加入 `.gitignore`；`backoffice/.env.local` 需按 `.env.example` 补齐后执行 `npm run db:migrate` + `bootstrap:admin`


---

## 2026-10-22 ~ BackOffice Portal P0 修复审查 Blocking（B1~B4）

- **任务**：修复自查审查中列出的 4 个 Blocking，并保证无回归；随后本地跑通并落库验证
- **用户拍板**：① 修复 B1~B4；② 先在本地跑起来（已执行迁移与 bootstrap）；③ 提交并推送 `feature/backoffice-portal`
- **变更清单**：
  - B2（PORT-ACT-003）：新增 `TOKEN_EXPIRED` / `TOKEN_ALREADY_USED` 错误码（410），
    `verificationTokens.ts` 抽出纯函数 `classifyTokenState` / `tokenStateToErrorCode`；
    Activate / Reset 页面按错误码显示专用面板（过期 / 已使用 / 无效）
  - B1（PORT-NAV-006）：新增 `lib/localeCookie.ts`、`lib/localePreference.ts`、
    `repositories/preferencesRepository.ts`、`app/api/preferences/locale`；
    middleware 按 URL 同步 Cookie；登录时读账号偏好并回写 Cookie，前端按返回的 locale 落地
  - B3：`/api/session` 不再从 `pathname` 解析 locale，改为 `?locale=` 显式参数 → Cookie 偏好 → 默认语言
  - B4：新增 `modules/rbac/access.ts`（纯判定），路由与测试共用；
    新增 4 个测试文件：access / verificationTokens / rateLimit / envelope
  - 其他：`package.json` dev/start 固定端口 3200（本机 3000 被 NestJS 占用）
- **本地运行环境**：复用现有 PostgreSQL 16（`learning_guide_db`），
  首次真实执行 `db:migrate` 与 `bootstrap:admin`，生成 `.env.local`（已被 .gitignore 忽略）
- **自测证据**：
  - `npx tsc --noEmit` 0 error；`npm run lint` 0 warning；`npm run test:unit` **44/44 通过**；`npm run build` 成功（23 路由）
  - HTTP 层 24 项实测：未登录 307/403、错密码 401、正确登录 200+Set-Cookie、
    重复邮箱 409、登出后会话失效、过期令牌 410 `TOKEN_EXPIRED`、重复令牌 410 `TOKEN_ALREADY_USED`、
    偏好存 zh-CN 后重新登录返回 zh-CN、`/api/session` landing 正常
- **仍未覆盖**：`client/`、`server/` 零改动；无 CSRF 令牌；限流仍为单实例内存；
  邮件仍为 console adapter；顶部栏缺 logo；迁移脚本无回滚（只做前向）


---

## 2026-10-23 ~ 视觉对齐学员门户（ilovelearningguide.com/zh-CN/portal）

- **用户要求**：页面风格与共享功能（中英文切换、登录等）需与
  `https://www.ilovelearningguide.com/zh-CN/portal` 保持一致
- **取基准方式**：抓取该站生产 CSS，直接采用其设计变量（未凭感觉配色）
  - `--color-primary:#0b63f6`、`--color-primary-hover:#0757d8`、`--color-primary-soft:#eaf2ff`
  - `--color-text-main:#0b1437`、`--color-text-muted:#5d6880`、`--color-border:#d9e2f1`、`--color-page-bg:#f8fafe`
  - 字体 `Inter, ui-sans-serif, system-ui…`；控件圆角 8px / 卡片 12px
- **共享组件对齐**：
  - 语言切换：改为胶囊显示当前语言短名（`EN` / `中`），点击切另一种（与其行为一致）
  - 登录页：深色背景图 + 居中白卡（`min(448px,100%)`）+ 邮箱优先两步 + 返回门户链接 + 法律声明
  - 认证背景图 `/portal/auth-library.jpg` 已复制到 `backoffice/public/portal/`
  - 应用外壳改为浅色主题（侧栏 `#eef1f6`），顶部栏补品牌位（PORT-NAV-001 logo 顺带落地）
- **有意差异**：不复制「创建账号 / Google / 微信登录 / 开始学习」，BackOffice 仅员工账号
- **自测**：`tsc` 0 error、`eslint` 0 warning、单元测试 44/44、`next build` 成功；
  HTTP 实测 `/en-GB/sign-in` 与 `/zh-CN/sign-in` 均 200，语言胶囊分别渲染 `EN` / `中`，
  背景图 `/portal/auth-library.jpg` 200（1,083,702 bytes）


---

## 2026-10-23 ~ 按 PRD 修正导航结构 + 修复登录页显示问题

- **用户反馈**：①「继续」「显示密码」按钮文字被换行；②登录后的功能菜单与 PRD 不一致
- **定位**：登录页报错为 React 补水告警（`A tree hydrated but some attributes…`），
  由输入框 `autoFocus` 导致 SSR 输出 `autofocus` 属性、客户端属性不一致
- **导航修正（对照 PRD 原文）**：
  - PORT-NAV-002：八个一级菜单顺序 Course/Knowledge/AI Tutor/Order/Reporting/Student/HelpDesk/Settings —— 原本已合规
  - §8.5 + §2 范围说明：Settings 应有**子导航**（Employee Account / Payment Gateway /
    Notification Configuration），原实现把「员工账号」放进员工下拉，缺子导航
  - PORT-NAV-005：员工下拉只含 Change Password 与 Sign Out —— 已移除多余项
  - §3.3 / PORT-LST-001：Employee Account 仅 Admin 可见，非 Admin 连子菜单都不显示
- **改动**
  - `modules/rbac/permissions.ts`：新增 `SETTINGS_SUB_ORDER` / `settingsSubHref` / `visibleSettingsSubs`
  - `components/AppShell.tsx`：Settings 变为可展开分组，子项高亮；下拉只留两项
  - 新增 `settings/page.tsx`（落到首个可见子项）、`settings/payment-gateway`、`settings/notification-configuration`
  - `globals.css`：`.button` 加 `white-space: nowrap`、`.inputRow` 内输入框自适应、新增子导航样式
  - `sign-in/page.tsx`：`autoFocus` → `ref + useEffect`
- **验证**：`tsc` 0 error、`eslint` 0 warning、单元测试 47/47、`next build` 成功；
  HTTP 实测 `/zh-CN/settings` → 307 → `/settings/employee-account`，三个子页面均 200；
  SSR 侧栏顺序断言为「课程→知识库→AI 导师→订单→报表→学生→服务台→设置→员工账号→支付网关→通知配置」


---

## 2026-10-23 ~ 按 BackOffice 设计稿（6 张图）重做界面

- **输入**：用户提供 PRD 对应设计稿截图：Menu & Role、Login、Employee Account、Employee Account add、Employee Account Edit
- **设计还原要点**
  - 顶栏：白底 56px 高的品牌条（蓝色圆角 logo + Learning Guide BackOffice）、右侧语言控件「EN ⌄」、头像 + 姓名/角色两行、员工下拉（Change Password / Sign Out，带图标）
  - 侧栏：白底 186px，8 个线性图标 + 文案，当前项浅蓝底蓝字，顶部折叠按钮
  - Settings：二级导航从「侧栏内嵌套」改为设计稿的**内容区左侧一列**（Employee Account / Payment Gateway / Notification Configuration）
  - 员工账号页：标题 + 副标题 + 右上「+ Add Employee」；搜索框带放大镜、All Roles / All Status 下拉；表格表头灰底、状态圆点（绿/琥珀/灰）、行尾 ⋮ 菜单（Edit / Reset Password / Pending 追加 Resend Activation）；页脚「显示第 1–8 条，共 8 名员工」+ ‹ 1 › 分页
  - 弹窗：标题 + 副标题 + 右上关闭；邮箱说明文案（新建=将发送激活邮件 / 已激活=不可修改）；Status 改为 Active/Inactive 分段卡片选择；按钮文案 Create Employee / Save Changes
  - 登录页：改为**单页表单**（邮箱 + 密码同屏），输入框内嵌 mail / lock 图标，邮箱校验通过显示绿色对勾，密码右侧眼睛切换，左对齐 Forgot password?，整宽 Sign in 按钮；移除两步式与法律条款块
- **新增文件**：`components/icons.tsx`（线性图标集）、`components/SettingsSubNav.tsx`
- **重写文件**：`app/globals.css`（按设计稿重建令牌与组件样式）、`components/AppShell.tsx`、`components/AuthLayout.tsx`、`components/LocaleSwitch.tsx`、登录页、员工账号客户端
- **验证**：`tsc` 0 error、`eslint` 0 warning、单测 47/47、`next build` 通过；
  SSR 断言：侧栏 8 项、设置子导航 3 项、标题/搜索/表格/分页/文案均渲染


---

## 2026-10-23 ~ 接入 Figma 元数据，界面数值对齐设计稿

- **读取链路**：Figma 链接直接抓取 403、内置浏览器需登录、figma MCP 未完成鉴权（0 tools）→ 改用用户提供的 Personal Access Token 调 REST API
- **新增脚本**
  - `scripts/figma-export.mjs`：拉取 `674:1186` 节点树 + 导出 6 个画板 PNG（scale=1）到 `docs/design/figma/`
  - `scripts/figma-spec.mjs`：把节点树压成规格表（几何/填充/圆角/自动布局/字体）
  - `scripts/figma-view-server.mjs`：本地静态服务，便于按 1:1 裁剪查看设计图
  - `scripts/figma-preview.mjs`：抓取已登录页面 SSR HTML 并内联 CSS，供离线比对（产物已 gitignore）
- **依据设计稿修正的关键数值**（此前实现整体偏小）
  - 画布底色 `#f7fafc`；主色 `#1d6bff`；次级文字 `#64748b`；表格文字 `#334155`
  - 顶栏 56→**68**，logo 26→**42**（学士帽图形），品牌字号 15→**20px/700**，语言控件 13→**20px**
  - 侧栏 186→**280**，菜单项高度 50、内距 16、图标 20、文字 **15px**
  - 设置子导航 186→**276**，项高 50、激活底色 `#e7eeff`
  - 主卡片 **1082 宽**、圆角 12、内距 28/32；标题 **22px/700 #1e293b**
  - 搜索框 494×34、下拉 250×34（原 150）
  - 表格表头高 50（`#f6f8fa`）、行节奏 51px、列宽 300/180/140/240/158
  - 弹窗 512→**832** 宽，输入框 38→**44**，Status 分段高 44，关闭键改为浅底方块
  - 登录卡片 358→**424** 宽、内距 36、圆角 16、输入框 42、标题 36px
- **验证**：tsc 0 error、eslint 0 warning、单测 47/47、`next build` 通过；CDP 实测（1672 视口）逐项比对 header 68 / sidebar 280 / nav 50 / subnav 276 / card 1082×852 / th 50 / td 51 全部一致


---

## 2026-10-29 Knowledge 编辑器替换为 CodeMirror 6（Markdown 源码 + 预览）

- **问题**：BlockNote 块编辑器在约 300 block / 35KB 的页面上「选中任意文字即卡顿、浏览器未响应」
- **排查结论**（有日志与源码证据）
  - Tiptap `update` 只在 `docChanged` 触发 → 纯选中不进我们的 `onChange`；`MutationObserver` 已于前一轮移除
  - 长任务 60~250ms 全部来自「整篇 blocks→markdown 序列化」（`toExternalHTML` 还会为每个 image block 建 DOM 并请求 URL）
  - 手测：关闭 BlockNote 全部浮动 UI（侧边菜单/格式气泡/链接条/表格手柄）+ 标题标签浮层后**完全无改善** → 结构性成本（整页单 contenteditable、无虚拟化、文档级选区）
- **参考**：Notion（块级独立编辑器 + 视口虚拟化 + 块级事务）、Jupyter（每 cell 独立 CM6 实例 + 模态编辑，JupyterLab 4 升级 CodeMirror 6）
- **改拍**（用户裁决）：放弃块级 WYSIWYG，改 **CodeMirror 6 纯 Markdown 源码编辑 + 标题栏「预览」按钮**
  - 新增 `src/components/knowledge/MarkdownSourceEditor.tsx`（CM6：行号/历史/查找/markdown 高亮/readOnly Compartment）
  - 重写 `src/components/knowledge/PageEditor.tsx`：删除 BlockNote 全套（schema、math 块转换、`tryParseMarkdownToBlocks`、`replaceBlocks`、pasteHandler、标签浮层）；预览复用 `MDEditor.Markdown + remark-math + rehype-katex`
  - `contentMd` 直接作为编辑器内容 → 整篇序列化链路彻底消失；TOC 改为按 markdown 行号定位
  - 依赖变更：新增 `@codemirror/{state,view,commands,language,lang-markdown,search}`；移除 `@blocknote/{core,react,mantine,math-block}`
- **保存策略变更**（用户指定）：编辑期间每 5 分钟自动保存 + 离开编辑页/切页/切课程立即保存；`flushSave` 改为返回 boolean 并在失败时阻断切换；新增 `pagehide/visibilitychange` 写 localStorage 草稿 + 打开页面时询问恢复
- **审查修复**（test_agent 5 项 Blocking）：跨页撤销污染（编辑器 `key=pageId` 重建）、`saved` 覆盖 `dirty`（改为请求快照比对）、保存失败静默丢稿（阻断 + 重试按钮）、刷新无兜底（本地草稿）、文档与日志未同步（本节 + §3.3.2/§3.3.3）
- **验证**：`npm run build`、`npm run lint`（0 error）
- **待用户裁决**：§3.3.3 section tags 编辑入口去向（预览态打标 / 侧栏打标 / 彻底下线）
- **复审后追加修复（同日）**
  - B6 本地草稿误恢复：`persistToLocal` 仅在 `dirty/saving/error` 时写；本地草稿的清理统一由 store 负责（保存成功、切页、激活版本、删除页均调用 `clearLocalDraft`）；恢复判定同时比较 `contentMd` 与 `title`，弹窗展示 `savedAt` 时间
  - B7 激活版本回写旧稿：`afterActivateRelease` 恢复「丢弃草稿 + 清本地草稿」语义（遵从 2026-10-19 既有裁决）；激活前的未保存提醒沿用 PublishPanel 现有 confirm 文案
  - B5 文档正文重写：§3.3.2「核心不变量 / 交互模型 / 保存与兜底 / 图片与表格 / 兼容性 / 依赖」全部按 CM6 实现重写，BlockNote 内容下沉为「历史选型（已废弃）」；§3.3.3 标注 tags 入口暂时下线
  - 附带：`selectPage` 在切换前再做一次提交+保存并校验 `saved/idle`，消除等待窗口内的丢稿风险；删除 `saveState==='saving'` 不可达分支；修正「序列化」陈旧注释
- **终审前修复（同日，第三轮）**
  - P2-1：`selectPage` 的 page 查找移到「最后一次 flush + 状态校验」之后，避免用旧 contentMd 作为新页基线
  - P2-2：切页/切课程改为最多 3 次有界重试（每次 120ms 间隔且先执行 `draftFlusher()`），仍不收敛则阻断切换（内容保留在 draft，不丢）
  - P2-3：`selectExternal` 与 `selectPage` 完全对齐（首 flush + 有界重试 + 末次提交 + 状态门禁 + `clearLocalDraft`）
  - P2-4：本地草稿恢复弹窗增加门禁，仅内存 draft 为 `idle/saved` 时提示，避免用更旧快照覆盖更新内容
  - P2-5：`deleteCourse` 删除当前课程时清当前页本地草稿
  - 文档：§3.3.2 标题改拍；§6.3「Markdown 编辑器配置」整节重写为 CM6 + 预览（旧 `preview="live"`/500ms 配置下沉为历史）；§3.3.3 标注 tags 编辑入口无入口；§3.2.1 / §5.1.6 / §6.2 补 2026-10-29 注记；§3.3.2 末尾新增「已知限制（2026-10-29）」5 条
  - 验证：`npm run build`、`npm run lint`（0 error / 11 既有 warning）
- **M1+M2（同日）：Live Preview 装饰层 + 格式工具条 + 右键插入**
  - 新增 `markdownLivePreview.ts`：CM6 ViewPlugin + Lezer 语法树，仅处理 `view.visibleRanges`；Heading 放大并隐藏 `#`、StrongEmphasis/Emphasis/Strikethrough/InlineCode 加样式并隐藏标记、无序列表隐藏 `- ` 改用 CSS 项目符号、表格行等宽对齐、围栏行弱化；**选区/光标进入范围时回退显示原始 Markdown**；代码块内不做装饰
  - 新增 `markdownCommands.ts`：`wrapSelection` / `toggleLinePrefix` / `setHeading` / `insertSnippet`（纯文本操作，基于 `changeByRange` 与 `dispatch`）
  - 新增 `MarkdownToolbar.tsx`：常驻顶部工具条（H1/H2/H3/段落、粗体 Ctrl+B、斜体 Ctrl+I、删除线、行内代码、行内公式、链接、无序/有序列表、引用），`mousedown` 阻止抢焦点以保住选区，`selectionchange` 同步高亮
  - `MarkdownSourceEditor.tsx`：接入 `markdownLivePreview` 扩展与 Mod-b / Mod-i 快捷键
  - `PageEditor.tsx`：编辑器包 `Dropdown` 右键插入（表格模板 / `$$…$$` / `$…$` / 图片 / 代码块 / 引用 / 分割线），插入后自动选中占位文本；`index.css` 新增 `.cm-md-*` 装饰样式
  - 文档：§3.3.2 交互模型补充 Live Preview / 工具条 / 右键菜单；已知限制新增「M3 公式与图片 widget 未做」「表格仅样式对齐」
  - 验证：`npm run build`、`npm run lint`（0 error）
- **M1+M2 审查后修复（同日）**
  - F1 块级插入黏连：`insertSnippet` 增加 `block` 选项（行中前补空行、行尾有内容时后补换行）；表格/公式块/代码块/图片/分割线按块级处理，行内公式与链接不补空行
  - F2 右键位置：编辑器外层 `onContextMenu` 用 `posAtCoords` 把光标落到点击处，插入位置与右键位置一致
  - F3 只读角色可被快捷键改写：四个命令统一加 `state.readOnly` 守卫；`MarkdownSourceEditor` 的只读 Compartment 同时设置 `EditorView.editable.of(!readOnly)`；Mod-b/Mod-i 只读时不拦截
  - F4 删除线不渲染：编辑器语言改为 GFM（`markdown({ base: markdownLanguage })`），`Strikethrough` / `Table` 节点可用，与预览端 `remark-gfm` 对齐
  - F5 有序列表多出项目符号：新增 `cm-md-oli`（无 ::before），仅无序列表用 `cm-md-li`
  - F6 关闭列表时空行被写前缀：`toggleLinePrefix` 先判定「移除方向」，移除时跳过空行
  - F8 装饰细节：隐藏标记改用严格相交判断；代码块区间改半开区间；行内节点按 `from` 去重；`update` 增加语法树身份变化重算；行内公式按钮改为插入 `$x$` 并选中 `x`（避免空选区产生 `$$`）
  - 验证：`npm run build`、`npm run lint`（0 error / 12 warning）
- **M1+M2 第二轮审查后修复（同日）**
  - R1 分割线/块级片段在段落行首：`insertSnippet` 的 `block` 前缀逻辑改为「行中补 `\n\n`；行首且上一行非空补 `\n`」，避免 `---` 把上一段变成 Setext 标题
  - R2 工具条 `$x$` 有选区时丢内容：有选区 → `wrapSelection('"'"'$'"'"')` 包裹选中文本；空选区 → 插入 `$x$` 并选中 `x`
  - R3 有序列表左移 6px：删除 `.cm-md-oli` 的 `padding-left: 0`（不再覆盖 CM6 `.cm-line` 基础 padding）
  - R4 行内标记内部光标不可见：行内隐藏判断恢复为**含端点**相交（`selectionTouches`），行首标记仍用严格相交
  - R5 已修复（`suffix` 改为基于 `lineAt(range.to)` 行尾，跨行选区不再黏连）；R6 仅部分缓解（紧邻既有 `|` 表格行插入新表格仍会被并入同一 GFM 表，已列入 §3.3.2 已知限制，待下一轮用空行分隔修复）
  - R7 右键折叠选区：点击落在已有选区内时保留选区，否则才把光标落到点击处
  - 验证：`npm run build`、`npm run lint`（0 error / 12 warning）
- **M3（同日）：公式 / 图片 / 表格就地渲染（Widget）**
  - 新增 `markdownWidgets.ts`：`InlineMathWidget` / `BlockMathWidget`（KaTeX `renderToString` + 结果缓存，失败退回原文）、`ImageWidget`（行内/块级、`loading=lazy`、显示 alt 题注）、`TableWidget`（GFM → `<table>`，含对齐解析）
  - `markdownLivePreview.ts` 新增 `buildWidgetDecorations`：块级公式按行配对 `$$…$$`、GFM `Table` 节点整体替换、`Image` 节点按「整行只有图片」判定块/行内、行内公式正则扫描（跳过代码块/表格/块级公式占用的行，拒绝 `$ 100 $` 这类货币空格写法）；返回 skipLines 供行级/行内层跳过，避免重复渲染
  - `index.css` 新增 `.cm-md-math-*` / `.cm-md-image-*` / `.cm-md-table-widget` 样式
  - 交互：光标/选区接触即回退源码（沿用 `selectionTouches`），Widget 为只读渲染
  - 文档：§3.3.2 交互模型与已知限制更新（M3 已实现；表格/公式 Widget 只读；外链图片失败/坏占位说明）
  - 验证：`npm run build`、`npm run lint`（0 error / 12 warning）
- **M3 审查修复（同日）**
  - P0：块级 Widget 从 ViewPlugin 迁出，新增 `markdownBlockWidgets.ts`（`StateField` + `EditorView.decorations.from`），修复 CM6「ViewPlugin 不得提供 block 装饰 / 跨行 replace」必然抛错问题；ViewPlugin 仅保留行级/行内单行 replace
  - P1-1：`StateField.update` 增加 `syntaxTree(startState) !== syntaxTree(state)` 判断，语法树异步推进（初始只解析前 ~3000 字符）后重建块候选，修复长文档尾部表格/图片不渲染
  - P1-2：行内公式扫描增加 `inCodeRange` 判断，围栏/缩进代码块内 `$x$` 不再渲染
  - P1-3：`collectBlocks` 按 from 排序做区间去重（块公式优先），消除块公式与嵌套表格/整行图片的 block replace 重叠
  - P2-1：多行 `$$` 的 latex 起点按 `line.text.indexOf('$$')` 计算，缩进写法不再把定界符带进 latex
  - P2-2：`$$ $$` / `$$  $$`（内容 trim 为空）保留源码，不再生成空块公式
  - P2-3：`MAX_BLOCK_MATH_LINES` 由 200 调整为 500（与验收口径一致）
  - P2-5：`occupied` 只包含「实际成功渲染」的块（无效图片不再占用整行）
  - P2-7：`mathCache` 改为简易 LRU（超过 500 只淘汰最早一条，不再整表清空）
  - 文档：§3.3.2 已知限制更新（StateField/ViewPlugin 双层、500 行上限、表格仅首行 `|`、单元格纯文本、畸形写法保留源码）
  - 验证：`npm run build`、`npm run lint`（0 error / 12 warning）
- **M3 终审后收尾（同日，非阻塞项）**
  - N1：§3.3.2 交互模型第 2 条补充性能口径（行级/行内按 visibleRanges；块级 StateField 全文档扫描 + 语法树推进后重建）
  - N5：多行空公式 `$$\n$$` 与畸形写法一致，保留源码不生成空 Widget
  - N3：`mathCache` 命中时 `delete + set` 移到队尾，改为真正 LRU（容量 500）
  - 审查结论：M3 APPROVE（0 Blocking）；剩余非阻塞项（500 页性能实测、HTMLBlock/多行 InlineCode 的 `$$` 排除、KaTeX 错误回退口径、客户端测试基建）已记录待后续
  - 验证：`npm run build`、`npm run lint`（0 error / 12 warning）
