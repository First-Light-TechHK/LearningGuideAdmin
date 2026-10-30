# P1b 实施计划（按 Aligned Design §12）

| 项 | 内容 |
|---|---|
| 依据 | `docs/Course_Management_PRD_v2_Aligned_Design.md`（Final，2026-10-30）§2–§12 |
| 目标 | 把 P1a 的 “Working copy → UAT → Approve → Go Live” 调整为 PRD v2 的 “Draft → Publish（生成版本）→ Change status”，补齐 History、Operations、Stripe、学员预览与环境标识 |
| 原则 | 编辑/导入/恢复只改草稿；线上内容来自版本快照；试看与价格不入版本快照；所有编号不复用 |

## 1. 任务拆解

### P1b-1 基础与配置
- 新增环境配置：`ENVIRONMENT_LABEL`、`PUBLIC_SITE_URL`、`VERSION_NUMBERING_MODE`、`STRIPE_SECRET_KEY`。
- 新增 `GET /api/backoffice/environment`；后台页头显示 Sandbox（紫）/ Production（红）。
- 课程包 manifest 增加 `source.environment` 与 `pricing`（价格随包）。

### P1b-2 草稿、发布与版本（核心）
- 数据：`CourseVersion` 增加 `versionLabel/versionSeries/versionMinor/sourceEnvironment/sourceVersionLabel/exportedAt/exportedBy`；`CommerceCourse` 增加 `hasDraft/draftSource*`；`Lesson.archivedAt`。
- 版本快照保存完整内容（课程信息 + Lesson/LP/文本/展品/测试/Reading/媒体引用），不含试看与价格。
- `POST /courses/:id/publish`：门禁（Course Information 完成 + 至少 1 个 Lesson 的 Study 完成）→ 生成版本号 → 线上版本立即生效 → 草稿置为 No draft → 首次发布状态变 Offline。
- `POST /courses/:id/delete-draft`：用线上版本覆盖草稿；从未发布时禁用。
- `POST /courses/:id/restore`：真实把版本快照写回草稿，并记录来源。
- `POST /courses/:id/live-status`：Online/Hidden/Offline，必须填原因，不生成版本。
- `GET /courses/:id/versions` + `GET /courses/:id/versions/:versionId`；`GET /courses/:id/history`。
- Portal 投影与学员预览改为读取线上版本快照（工作区仍是草稿）。

### P1b-3 版本编号
- Sandbox：`1.1、1.2…`；某版本导出后下一次发布进入 `X+1.1`。
- Production：`Version N`，并记录来源（`Sandbox X.Y` / `Restored from Version N` / `—`）。
- 编号持久化到版本记录，永不复用。

### P1b-4 课程包
- 导出只允许线上版本，且 3 步必须完成；标记 `Exported` 并写 History。
- 导入到已有课程：只替换草稿，Course ID 必须一致；试看与价格随包更新；线上版本不变。
- 从包新建：保留 Course ID / Lesson ID（Lesson code 即对外 ID）。

### P1b-5 试看与价格
- `GET/PUT /courses/:id/trial`：总开关、连续试看 Lesson、Video/Text 截止点、Ready/Re-confirm/Locked。
- `GET/PUT /courses/:id/plans`、`POST /courses/:id/plans/:planId/sync-stripe`。
- 保存试看/价格不生成版本；Restore 不改变试看与价格。
- Stripe：每课一个 Product，套餐一个 Price（subscription, USD, lookup key `CourseID_周期`）；改价新建 Price 并停用旧 Price；失败记录 `syncError` 可重试。

### P1b-6 Operations
- `GET/PUT /backoffice/operations/popular-courses`（1–6 门、去重、仅 Online）。
- `GET/PUT /backoffice/operations/discovery-banner`（单例；课程必须 Online 且 Trial 开启；中英文必填）。
- `POST /backoffice/operations/publish`：立即生效、写 History、不生成课程版本。

### P1b-7 前端
- Course Overview：列表 + 状态 + Operations 入口；移除 Publish UAT / Approve / Go Live。
- Course Editor：Course Information / Course Content / Trial & Pricing / Versions & History 四个区域；Save / Save & next；Publish 门禁提示。
- 学员视角预览：对齐 Portal 字段（category/title/shortDescription/overview/whatYouLearn/lessons+duration/provides/试看/价格），可预览指定版本。
- Operations 页：Popular Courses + Discovery Banner + Publish。

### P1b-8 验证
- `prisma validate` / `prisma generate`；server `build + lint + test`；client `build + lint + test`。
- 更新 `docs/AI_Collaboration_Log.md`。

## 2. 关键实现决策
1. **工作区行 = 草稿**：Publish 时生成不可变快照；线上展示（Portal / 学员预览线上模式 / 导出）读快照，保证保存草稿不改变线上。
2. **Lesson ID**：课程包以 `Lesson.code` 作为跨环境稳定 ID；导入已有课程时按 code 复用 Lesson 行 ID。
3. **试看/价格不入快照**：Restore / Delete draft 只覆盖内容，不覆盖试看与价格。
4. **History**：只记录 PRD §21 明确的操作（Publish / Delete draft / Restore / Export / Import / Change status / Operations publish / Create course）。
5. **软删除**：Lesson 用 `archivedAt`；删除后 ID 不复用，发布后才从线上消失。
