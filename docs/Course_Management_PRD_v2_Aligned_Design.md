# Course 模块开发架构设计（PRD v2.0 最终确认版）

| 项 | 内容 |
|---|---|
| 状态 | **Final（已确认）** |
| 日期 | 2026-10-30 |
| 范围 | Admin 的 Course（商品课程）模块 + Portal Integration API + Portal 消费侧 + 数据迁移；对齐 PRD v2.0 全文（`docs/Course_Management_PRD_v2.0_CN.docx`） |
| 依据 | PRD v2.0（§1–§26）；`docs/Course_Module_Architecture_Design.md`（v1）；`docs/Course_Module_Import_Export_Design.md`（v2，Frozen）；已实现的 commerce-courses 模块；Portal 学员端课程页 |
| 不在范围 | KS / AI Tutor 内部；Order / Reporting / Student / HelpDesk；Portal 支付/订阅/权益/进度/小组/通知 |

> 本文件为**最终确认版设计**。确认后按 §12 路线执行；开发前请再对照 PRD §24 待开发确认事项（§15）。

---

## 0. 结论摘要（TL;DR）

1. **PRD v2.0 全文已落盘**（docx → `docs/prd_full.txt`），本设计按其 §1–§26 校准，替代 Draft 版中的 "待全文校验" 风险。
2. **两套环境（Sandbox/Production）+ 简化状态机（Not published/Online/Hidden/Offline）**：移除 v1 的 UAT/Approve/Go Live 三步，合并为单一 `Publish`（草稿 → 版本 → Offline）+ `Change status`。
3. **版本编号**：Sandbox fractional `X.Y`（导出后进入下一整数系列 `X+1.1`）；Production integer `Version N` + 来源字段；编号永不复用、不可删除，回退 = Restore → Publish 新版本。
4. **v2 存储模型继续有效**（CommerceCourse/CourseLocalization/Lesson/…/CourseVersion/CoursePackageJob/PopularCourseEntry/DiscoveryBanner），仅做最小字段调整（版本编号、Stripe ID）。
5. **Stripe 价格自动创建**：保存价格时按环境 Stripe 账号创建/更新 Product + Price（lookup key），导入后在目标环境重新创建；Stripe ID 不进入课程包。
6. **History**：Versions 页底部只读列表，记录 PRD 明确写入的 6 类操作（Publish / Delete draft / Restore / Export / Import / Change status）；内容编辑、试看、价格修改不写入（§24 待确认）。
7. **删除**：课程仅软删除（archived），课时/章节软删除，媒体仅未引用可删；硬删除需校验无订单/进度/权益引用。
8. **Operations**：Popular Courses（1–6，仅 Online 可加入）+ Discovery Banner（单例，featured course 必须 Online 且 Trial 启用），修改后 Publish 立即生效，不生成版本。
9. **Portal**：课程主键对外以 `code`（Course ID）为主，`slug` 为路由别名；Admin 编辑器的"学员视角预览"投影与 Portal modeling-life 一致的字段集。
10. **环境差异只在配置**，代码不按环境分支；Production 也有 Export 按钮但流程上不使用。

---

## 1. PRD v2.0 关键需求（对架构的影响）

### 1.1 两套环境（PRD §3.1）

| 配置项 | Sandbox | Production |
|---|---|---|
| 环境标识（页头） | Sandbox（紫） | Production（红） |
| 网站地址 | 测试地址 | 正式地址 |
| Stripe key | 沙盒 | 正式 |
| 版本编号方式 | X.Y | Version N |

新增 env：`ENVIRONMENT_LABEL`、`PUBLIC_SITE_URL`、`VERSION_NUMBERING_MODE=sandbox|production`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`（可选）。代码不按环境隐藏功能。

### 1.2 角色（PRD §3.2）

本期后台只有 Operator，不做细分权限；其他后台角色按 Back Office 矩阵只读。现有 RBAC 的 Course FULL/EDIT/VIEW 保留矩阵，Operator = FULL，其余 = VIEW，无结构变化。

### 1.3 术语与数据层级（PRD §4）

- 层级：**Course → Lesson → Learning Point**。Exhibit、Recommended Reading、Knowledge Test、Application Test 归属 Lesson。
- **Course ID**：课程主体唯一且不可修改。对应 `CommerceCourse.code`（如 `C001`）。SDK/接口以 `code` 作为主键暴露给 Portal/AI。
- **ID 规则**：所有 ID 在后台 UI 显示；同一环境内 ID 不随版本变化；删除后不复用；跨环境仅要求 Course ID 与 Lesson ID 导入后保持不变（进度/运营数据按这两个 ID 统计），其余 ID 是否保持由开发决定（§24）。
- **Draft**：编辑、导入、恢复都只改草稿；保存不生成版本。

### 1.4 MVP 范围（PRD §2）

**包含**：课程列表+Category 筛选；空白新建/从包导入；Course ID；3 步配置；Understanding 批量/单 Lesson 导入；Recommended reading 批量导入；添加学习语言；价格（订阅，USD）+ Stripe 自动创建；Draft/Publish/Delete draft；版本管理（编号/列表/查看/恢复）；课程包导出/导入/新建；状态切换；History；Operations；环境配置。

**不包含**：审批/预览/Super User 预览、系统内通知、版本删除/对比/一键回切、导入检查报告、环境自动同步、搜索/看板、History 筛选导出、自动保存、后台视频播放器、删除学习语言、创建后改 Learning mode、运营位定时发布、Banner 背景图配置、中文后台、细分权限。

### 1.5 整体流程（PRD §5）

- **新课程上线**：Sandbox 创建 → 测试 → 导出包 → Production 导入 → Publish（Version 1）→ Change status Online。
- **已上线课程更新**：Sandbox 修改草稿 → Publish → 测试 → 导出 → Production 导入（替换草稿，线上不变）→ Publish（新整数版本，状态保持）。
- **回退**：Change status Hidden/Offline（可选）→ Restore 旧版本 → Publish 新版本（来源 "Restored from Version N"）→ 改回 Online。
- **添加学习语言**：Course Information + Add learning language → 补齐所有 Lesson 材料 → Publish → 测试 → Production。
- **上下架**：Course Overview 行菜单或 Versions 页 Live 行 Change status。
- **运营位发布**：Operations 页修改后 Publish，立即生效，不生成版本。

### 1.6 信息结构与导航（PRD §6）

后台左侧一级导航 + 内容区；页头显示环境标识；Operations 从 Course Overview 右上角进入（面包屑 Course Overview / Operations）；课程详情面包屑 Course Overview / 课程名；课程详情 3 个 Tab（Course Information / Course Content / Trial & Pricing，实际按现有 3 步）。

### 1.7 课程详情通用规则（PRD §10）

- **头部**：课程名、Course ID（可复制）、Category、学习模式、学习语言、Lesson 数；状态条两段（Draft 状态 + 完成度 / Live 状态）；发布按钮在 Versions 页。
- **Content 步骤条**：每步 Complete/Incomplete；第 2 步 Complete = 所有 Lesson 的 Study & Exploration 与 Understanding 都 Complete；可随时切换，不按顺序。
- **保存**：不做自动保存；每步底部 Save / Save & next；第 3 步 Trial 只有 Save；保存只更新草稿；离开未保存页面时提示。Save & next 线性顺序：Course Information → Lesson01 Study & Exploration → Lesson01 Understanding → … → Trial。
- **课程设置条**（第 2、3 步顶部）：只读 Learning mode + Learning languages（锁图标）+ Content language 切换（EN/中文）；单语言时隐藏切换；添加语言入口只在 Course Information。

### 1.8 Course Information 字段（PRD §11）

所有字段中英文并列，均为必填；Course Information 是学生端卡片/详情页唯一数据源。

- **Basics**：Category（CourseCatalogueEntry）、Course ID（只读）、Learning mode（创建后锁定）、Learning languages（只能增加）。
- **Title and descriptions**：title（中/英）、shortDescription、overview；无硬性字数上限，超建议长度标黄 "Longer than recommended"，不阻止保存/发布。
- **What you'll learn**：课程级，不从 LP 自动生成；每项中英文必填；可新增/删除/拖拽排序；最少 4 条，建议 6，无上限；4–5 条提示 "6 recommended"；建议长度英 55/中 25。
- **This course provides**：最少 4，最多 6，建议 6；满 6 后添加置灰；预设项（图标+中英文固定，开发维护）+ 自定义项（2 个通用图标选 1，默认第 1 个；必须填中英文文案）；可拖拽/删除。
- **多语言**：中文网站读中文 Course Information，英文读英文；单语言课程在网站语言不同时提示实际学习语言。

### 1.9 Course Content · Study & Exploration（PRD §12）

- **页面**：左侧 Lesson 列表，右侧编辑区；顶部 Import 菜单（Understanding 全部 Lesson / Recommended reading 全部 Lesson）；Lesson 行显示序号+标题+补充信息（时长·LP 数·展品数 / 题目数·是否有 App test）+ 两个状态圆点；底部 + Add Lesson；支持拖拽排序；Remove lesson 二次确认；被移除的 Lesson 在下次 Publish 后才从网站消失，学员历史保留。
- **Lesson info**：标题、描述。
- **Exhibits**：归属当前 Lesson；列表顺序 = 学生端顺序；批量上传（自动识别类型，进度，未补全行橙色边框+Complete 按钮）；编辑抽屉 + Preview as learner；删除被引用时提示引用位置。
- **Study content**：Video/Text 子 Tab（Video and Text 模式）；视频 LP 与文本 LP 独立，不校验一致性。
  - **Video**：按学习语言上传；时长上传后读取，不可人工填；Lesson 时长=视频时长；Course 时长=全部 Lesson 时长之和；Text only 不显示时长；LP 表（编号、时间点 mm:ss、标题）；Exhibit triggers 表（时间点+展品）；时间点必须在视频时长内，超出标红；后台无视频播放器。
  - **Text**：富文本编辑器（H1/H2/H3/粗斜体/列表 + Insert exhibit）；来源 Google Docs 粘贴或 Import .docx；LP 识别：仅 H1 为 LP，H1 文本即标题；识别区表格与正文同一数据；校验：至少 1 个 LP、标题非空、LP 下必须有正文；有问题标红，可保存但 Incomplete。
- **Recommended reading**：本 Lesson 延伸阅读；学生端只读展示；只有英文一份列表；字段 type（Book/Article/Paper/Other）、title、author、whyRecommended；可增删排序；批量导入（xlsx/csv，按 Lesson ID 匹配，追加，校验结果按 Lesson 列出新增数，错误行列出行号+原因，错误行不导入；模板预填 Course ID/Lesson ID/标题）。

### 1.10 Course Content · Understanding（PRD §13）

- **Knowledge Test**：Enabled 开关；关闭则不计完成度、学生端不显示；每题 Question + Reference answer 必填（建议 200/600 字符，超只提示）；按添加顺序，新题末尾，不可调序；导入题按文件行顺序追加；每题显示 Question ID（K-0201）；无单题开关；删除有作答的题目时确认弹窗提示作答人数，历史作答保留；新增题末尾 Question 输入框自动焦点；单 Lesson 导入（xlsx/csv）+ Download template。
- **Application Test**：Enabled 开关；每 Lesson 一题：Question 必填不限字数、Reference answer 必填不限字数；学员提交且 AI 评估后展示。
- **Import Understanding 全部 Lesson**：入口 Lesson 列表顶部 Import → Understanding；模板预填 Course ID/全部 Lesson ID/标题；每行一题（Knowledge/Application、Question、Reference answer）；一个文件只对应一种学习语言；流程 上传 → 校验（读取行数、各 Lesson 新增题数、错误行）→ Import N questions；只往已有 Lesson 加题，不新建；Knowledge 按行顺序追加；Application 每 Lesson 只一题，已有或文件中重复则该行报错不覆盖；文件列与模板不一致则整个文件拒绝。

### 1.11 Trial 与 Pricing（PRD §14）

**Trial**：
- 直接引用正式学习内容，不创建试看副本；视频按截止时间点，文本按截止 LP。
- Trial enabled 总开关；关闭后无试看，Discovery Banner 也不能选该课程。
- 试看 Lesson 从 Lesson 01 开始连续选择（In trial 开关）；前面 Lesson 完整开放，截止点只作用于最后一个试看 Lesson。
- 截止点：Video mm:ss 必须在视频时长内；Text 从该 Lesson 文本 LP 中选；Video and Text 分别设置；按学习语言分别设置。
- 试看范围内展品可打开；打开展品不扩大试看范围。
- 重新确认：截止点所在 Lesson 视频被替换或截止 LP 被删除/重排后，该 Lesson 状态 Re-confirm，顶部提示 + Confirm cut-off；确认前 Incomplete。
- 每行状态：Ready / Re-confirm / Locked；表格下方汇总 Video trial / Text trial 范围与可打开展品数。
- 试看设置随课程包带入；导入后可单独修改，Save 立即在本环境网站生效，不生成版本；试看不属于版本快照；Restore 不改变当前试看。

**Pricing**：
- Pricing Tab 配置订阅套餐；本期只支持 USD。
- 页面：套餐列表（名称、Billing 周期、价格 amountMinor、currency、stripeLookupKey）+ Add plan + Save。
- Stripe 关系：Save 时 Admin 调用 Stripe API 在本环境账号创建/更新：课程 → Stripe Product（每门课一个，metadata 带 Course ID）；套餐 → Stripe Price（订阅，周期按 Billing，USD），lookup key 格式 `CourseID_周期`。
- Sandbox 连沙盒，Production 连正式，由配置决定，代码相同；两边 Stripe ID 不同，系统内部按 lookup key 对应，不在课程包带 Stripe ID。
- 改价：Stripe 价格创建后金额不可修改；改价时系统新建 Price 并沿用同一 lookup key，旧 Price 停用。
- 价格随课程包带入；导入后目标环境 Admin 自动重新创建产品和价格。
- 价格不属于版本快照，修改不生成版本；Restore 不改变当前价格。

### 1.12 草稿、发布与版本（PRD §15）

**Draft**：
- 每门课程一份草稿；后台编辑 Save、导入包、Restore 都只改变草稿。
- 草稿两种状态（系统自动判断）：No draft / Draft；完成度 "N of 3 steps complete"；导入草稿显示 "Imported · 3 of 3 steps complete"。

**Publish**（Versions 页 Current 区 Draft 行）：
- 草稿为 No draft 时置灰。
- 弹窗内容：确认发布。
- 确认后：生成版本号；草稿保存为该版本只读快照；该版本成为本环境网站线上版本立即生效；草稿变为 No draft；课程状态不变；写入 History。
- 允许发布不完整内容（Sandbox 分批测试），前台展示规则：
  - Course Information 未完成 → 不允许发布，按钮置灰，悬停 "Complete Course Information first"。
  - 某 Lesson Study & Exploration 未完成 → 该 Lesson 不在前台显示。
  - 某 Lesson Understanding 未完成 → 该 Lesson 测试不显示。
  - Trial 未完成 → 课程不提供试看。
  - 至少 1 个 Lesson 的 Study & Exploration 完成，否则不允许发布，提示 "Complete at least 1 lesson first"。
- Production 内容来自包，导出时已要求完整，一般无空缺提示。

**版本编号**：
- 由环境配置决定：
  - Sandbox：`X.Y`，新建课程第一次发布 `1.1`，之后每次 Y+1；导出后下一次发布进入下一整数系列 `X+1`，Y 从 1 开始；从包新建/导入到 Sandbox 时按本规则继续，不沿用包中编号。
  - Production：`Version N`，第一次 `Version 1`，之后 N+1；每个版本记录来源：
    - 从包导入后发布：`Sandbox X.Y`（包导出时的 Sandbox 版本号）。
    - Restore 后发布：`Restored from Version N`。
    - Production 直接编辑后发布（不建议）：`—`。
  - 通用：编号永不复用，版本不可删除；两套编号不要求一一对应；数据中使用完整编号如 `C001-V4`、`C001-V4.2`；实现尽量简单（一个配置项区分）。

**Delete draft**（CM13）：
- 删除未发布草稿（含导入的包）；网站继续使用当前线上版本；草稿恢复为与线上版本一致（No draft）。
- 位置 Draft 行 Delete draft；草稿为 No draft 或从未发布时置灰。
- 弹窗：`The draft is deleted, including any imported package. The website keeps Version N. This cannot be undone.`；显示当前草稿状态和保留的线上版本；Cancel / Delete draft（红）。
- 写入 History。

**版本列表**（Versions 区）：
- 按版本号倒序；表格下方一行说明编号规则。
- View：只读打开该版本 Content 页，顶部标明版本号，所有输入/按钮不可用。
- 每个版本保存完整快照：课程信息、全部 Lesson、LP、文本、测试、文件引用；视频/展品等文件各版本间共用，未更换文件只存一份；试看设置和价格不在快照内。

**Restore**（CM14）：
- 在非线上版本行点 Restore。
- 弹窗：`Version N is copied into the draft and replaces the current draft. Publish it to go live as Version M. What is live does not change until then.`；显示当前草稿状态和发布后的版本号与来源。
- 确认后：草稿 = 该版本全部内容，沿用原有 ID；当前未发布修改被替换；草稿完成度按当前规则重新判断（例：新增学习语言后恢复，缺少该语言内容则相关步骤 Incomplete）；写入 History。
- 之后 Publish 生成新版本号，来源 "Restored from Version N"。

### 1.13 课程包导出与导入（PRD §16）

**课程包内容**：内容数据 + 文件；文件名 `CourseID_版本号.zip`（如 `C001_4.2.zip`）；体积可能 GB 级。

**导出**（CM17，Sandbox 使用）：
- 位置 Versions 页 Live 行 Export package。
- 导出的是当前线上版本（已发布到 Sandbox、测试过的），不能选草稿/其他版本。
- 弹窗：`Export Version X.Y?`；说明导出测试过的线上版本，包含内容/文件/试看设置/价格；显示版本号/文件名；提示 "After the export, the next publish here starts Version X+1.1."。
- 导出前检查完整性：该版本 3 步必须都完成；不完整时 Export 不可用，提示 "This version is incomplete. Complete all 3 steps, publish, then export."。
- 导出后：版本显示 Exported + 日期；下一次发布进入新系列；写入 History。
- Production 同样有此按钮（同一套代码），流程上不使用。

**导入到已有课程**（CM16）：
- 位置 Versions 页 Current 区 Draft 行 Import package（Course Overview 行菜单不放）；任何时候可用；已有未发布草稿时导入替换它。
- 弹窗：说明 "The package replaces the draft of this course. What is live does not change until you publish."；上传 .zip，显示文件名/大小/上传状态，可 Replace file。
- 校验：包中 Course ID 必须与当前课程一致，否则拒绝，提示 "The Course ID in the package must match this course, or the import is refused."。
- 导入后：草稿被包内容替换，显示 "Imported · N of 3 steps complete"；试看设置和价格按包更新；价格自动在本环境 Stripe 创建；线上版本不变直到 Publish；写入 History（Import package · Draft replaced · 文件名）；不生成导入检查报告，Operator 按步骤条检查空缺后 Publish。

**从包新建课程**（CM04）：
- 上传 .zip，显示文件名/大小/进度，可 Replace file。
- 点 Create course：系统读取包，创建课程，使用包中 Course ID 与 Lesson ID；全部内容/文件/试看设置/价格写入新课程草稿；状态 Not published；草稿需 Publish 才生成版本。
- 包中 Course ID 在本 Admin 已存在时按**Course ID 冲突规则**处理（见下）。
- **Course ID 冲突处理（覆盖规则）**：包中 Excel 的 Course ID 与本环境中已有课程相同时：
  - 已存在课程为**草稿状态**（从未发布、无线上版本，`liveVersionId` 为空）：询问是否覆盖——`Course <ID> already exists as a draft. Overwrite its sandbox draft?`；选**覆盖**→ 用包内容替换该课程草稿（仅影响沙盒草稿，线上版本不变）；选**忽略**→ 取消导入，不改动已有课程。
  - 已存在课程为**已上线状态**（已有线上版本）：拒绝导入，提示 `Course <ID> is already live, the import is refused. Only draft courses can be overwritten.`；线上内容不受影响。
  - 关键约束：覆盖仅作用于沙盒草稿内容，**绝不影响到已上线状态的内容/课程**；只有状态为草稿（从未发布）的课程才允许被覆盖。
- 价格：导入完成后系统在本环境 Stripe 自动创建产品和价格。

### 1.14 课程状态（PRD §17）

**状态**：Not published →（第一次 Publish）→ Offline ⇄ Online ⇄ Hidden（Change status 互相切换，必须填原因）。
- 第一次 Publish 后为 Offline，Operator 确认无误后改为 Online 才上线。
- 之后再 Publish 新版本，状态保持不变；已 Online 时新版本立即对学员生效。
- 状态变化不生成版本。

**Change status**（CM15）：
- 入口：Versions 页 Live 行 Change status；Course Overview 行菜单 Change status；Not published 时置灰，悬停 "Publish first"。
- 弹窗：显示当前版本和状态，说明 "Changing the status does not create a version."；选项 Online/Hidden/Offline（当前状态标 Current + 一行说明）；Reason 必填；按钮文字随选项变化。
- 确认后立即生效，写入 History。
- 对运营位影响：改为 Hidden/Offline → Popular Courses 推荐项失效（后台标红，学生端跳过）；如被 Discovery Banner 推荐，Banner 停止展示；恢复 Online → Popular Courses 推荐项自动恢复；Discovery Banner 需运营重新 Publish。

### 1.15 版本更新对学员的影响（PRD §18）

- 所有学员始终使用本环境线上版本，不保留旧版本给老学员。
- 每条学习记录记录版本号（完成 LP、作答、提交 Application Test 等）。
- 运营数据（点击/浏览/学习人数）按 Course ID、Lesson ID 跨版本累计，版本号仅作为筛选条件。
- 每次 Publish 后，系统重新计算前台课程信息（Lesson 数、时长、LP 数）和已报名学员进度；AI 模块按新版本更新知识库。
- Publish 弹窗勾选 "Notify enrolled learners" 时向已报名学员发站内通知；依赖通知中心，上线前可隐藏/不发送。

### 1.16 Operations（PRD §19）

从 Course Overview 右上角 Operations 进入；两个 Tab：Popular Courses、Discovery Banner；修改后点 Publish 确认后立即在本环境网站生效；不设草稿，不生成课程版本；显示最近发布时间和操作人；运营位不在课程包中，两环境各自配置。

**Popular Courses**（CM18）：
- 配置 1–6 门课程，拖拽排序，同一课程不能重复。
- 每行：位置号、封面、课程名、Course ID、分类、状态、移除按钮。
- + Add course：搜索并选择，只列出 Online 课程，已添加的置灰。
- 卡片内容全部读取 Course Information，不单独配置。
- 课程变为 Hidden/Offline 后，推荐项保留并标红，提供 Replace；学生端跳过。

**Discovery Banner**（CM19）：
- 课程发现页只有一个固定 Banner，不轮播；Show banner 开关。
- Featured course：下拉只列出 Online 且 Trial 已启用的课程。
- 中英文并列填写，均必填：Headline（建议 40/20）、Subheading（90/45）、Button label（20/10）；超建议长度只提示。
- 按钮固定进入所选课程的 Trial；背景图由开发控制；下方提供 Banner 预览，可切 EN/中文。
- 所选课程变为 Hidden/Offline 或 Trial 被关闭时，Banner 停止展示并在后台标出，直到运营更换课程并重新 Publish。
- Show banner 开启时，课程和中英文文案都必须填写，否则 Publish 不可用，缺失字段标红。

### 1.17 校验规则（PRD §20）

三级：
- **未完成（Incomplete）**：保存时字段标红，对应部分和步骤显示 Incomplete。
- **提示**：标黄，不阻止保存和发布。
- **拦截**：操作当时直接阻止并提示。

### 1.18 History（PRD §21）

Versions 页底部只读列表，分页；不做筛选和导出。
列：Time、Operator（操作人姓名）、Action、Detail。
- 内容编辑（Save）、试看和价格修改本身不写入 History（是否需要另行记录，见 §24）。
- 每条记录至少保存：Course ID、版本号、操作类型、原值、新值、操作人、时间、原因或备注；记录不允许修改或删除。

### 1.19 删除与引用保护（PRD §22）

- 被视频触发点或文本引用的展品不能删除，删除时提示引用位置。
- 删除 Lesson、展品、Reading、题目需要二次确认。
- 草稿中删除的内容，下次 Publish 后才从网站移除；学员历史进度和测试结果保留。
- 所有 ID 删除后不复用。
- 学习语言添加后不能删除；Learning mode 创建后不能修改。
- 版本不可删除；课程 Offline 不删除课程和学员数据。

### 1.20 异常处理（PRD §23）

统一错误码表（§6）；前端错误映射集中在 `course.errors.*` i18n。

### 1.21 待开发确认事项（PRD §24）

见 §15。

### 1.22 验收标准与测试要点（PRD §25）

见 §13。

### 1.23 后续阶段（PRD §26）

细分权限、版本差异对比、环境自动同步、课程搜索/看板、运营位定时发布。

---

## 2. 对现有架构的调整（v1/v2 → PRD 对齐）

### 2.1 状态机简化（最大调整）

移除 `publish-uat` / `approve` / `go-live` 三步 API 与按钮，合并为单一 `POST /courses/:id/publish`（草稿 → 生成新版本 → status 变为 Offline，首次）。保留 `POST /courses/:id/live-status`（Online/Hidden/Offline 切换，不生成版本）、`restore`、`versions`、`import`、`export`、`import/:jobId/*`。

`lifecycleStatus` 保留但弱化：仅内部标记（WORKING = 有未发布草稿变更），UI 主要展示 `liveStatus` + 是否有 live version。不移除 UAT 字段（`currentUatVersionId`、`approvedAt`、`approvedBy`、`lastUatPublishedAt`）以避免迁移成本，仅不在 UI/API 暴露。

### 2.2 版本编号

新增 `CourseVersion.versionLabel String`（如 `"1.2"` / `"Version 3"`）、`versionSeries Int`（Sandbox 导出后 +1）、`sourceEnvironment String?`、`sourceVersionLabel String?`。保留 `versionNo Int` 作为内部排序序号（自增）。编号逻辑由 `VERSION_NUMBERING_MODE` 决定（§3）。

### 2.3 价格与 Stripe

`CoursePlan` 增加 `stripeProductId`、`stripePriceId`、`lastSyncedAt`。新增 `CommerceCoursesService.syncStripePrice(plan)`：按环境 `STRIPE_SECRET_KEY` 调用 Stripe API 创建/更新 Product + Price；幂等（已有 stripePriceId 则跳过，除非金额变更则新建 Price）。触发时机：价格保存时（非 Publish），失败返回 `STRIPE_SYNC_FAILED`。导入包时**不**搬运 Stripe ID，仅搬运 `amountMinor/currency`；导入后 Operator 在本环境重新同步。价格变更不生成版本。

### 2.4 试看配置

Trial 变更不触发版本生成，不取消 approve（无 approve 步骤）。保持现有 `TrialSetting`，确保编辑 Trial 不 bump 版本。试看设置不属于版本快照；Restore 不改变当前试看。

### 2.5 History / 审计

扩展 `CourseAuthoringActivity.action` 以覆盖 PRD 明确写入的操作（§7）。新增 `GET /api/backoffice/courses/:id/history`（分页），前端 History 页。保留现有审计约束（不写富内容/媒体二进制/明文 token）。

### 2.6 删除与引用保护

课程仅软删除（`liveStatus = OFFLINE` + `archivedAt`），不物理删除；课时/章节软删除（`archivedAt`），保存草稿时通过 `removedLessonIds` 标记（已有）；媒体仅允许删除未被引用资产；发布前校验引用完整性。未来硬删除需先校验无订单/进度/权益引用，否则拒绝并返回 `COURSE_REFERENCED`。

### 2.7 异常处理

以现有错误码为准，新增 `STRIPE_SYNC_FAILED`、`COURSE_REFERENCED`、`VERSION_NOT_FOUND`。前端错误映射集中在 `course.errors.*` i18n。

### 2.8 Operations

新增 `GET/PUT/POST /api/backoffice/operations/popular-courses` 与 `discovery-banner`（v2 §18 已定义），前端 Operations 页。Banner 背景图不入课程包。

### 2.9 Portal 学员端对齐

Portal 课程详情页字段：category、title、shortDescription、overview、whatYouLearn、lessons（title+duration+description）、试看（trial）、provides（preset/custom）、价格（subscription plan）、总时长、课时数。Admin 编辑器的"学员视角预览"应投影相同字段，复用 v2 模型。Portal Integration API 的 v1 投影继续按开关启用。课程主键对外以 `code` 为主，`slug` 为路由别名。

### 2.10 环境配置

见 §1.1。

---

## 3. 存储模型调整（Prisma）

基于 v2 schema（已落库），**最小调整**：

| 变更 | 说明 |
|---|---|
| `CourseVersion` 加 `versionLabel String`、`versionSeries Int`、`sourceEnvironment String?`、`sourceVersionLabel String?` | 环境相关编号与来源追踪 |
| `CoursePlan` 加 `stripeProductId String?`、`stripePriceId String?`、`lastSyncedAt DateTime?` | Stripe 自动创建 |
| `CommerceCourse` 保留 `lifecycleStatus`/`liveStatus`，但 UI/流程按 PRD 简化（§2.1） | 兼容已落库数据 |
| `CourseAuthoringActivity.action` 扩展枚举（§7） | History |
| 新增错误码：`STRIPE_SYNC_FAILED`、`COURSE_REFERENCED`、`VERSION_NOT_FOUND` | §2.7 |
| `CommerceCourse.archivedAt` 已存在 | 软删除 |

**不移除** v2 的 UAT/approve 字段（`currentUatVersionId`、`approvedAt`、`approvedBy`、`lastUatPublishedAt`）以避免迁移成本；仅不在 UI/API 暴露。后续可清理。

**学习语言/模式锁定**：`learningMode` 创建后不可修改（前端禁用 + 后端校验）；`learningLanguages` 只能追加（后端拒绝删除）。

**Lesson 软删除**：`Lesson` 表增加 `archivedAt DateTime?`（或复用现有 removedLessonIds 机制）；发布前校验引用完整性。

---

## 4. API 调整

### 4.1 员工侧（`/api/backoffice/courses`）

保留 v2 端点，**移除/合并**：
- 移除：`publish-uat`、`approve`、`go-live`（合并为 `publish`）。
- 保留：`live-status`、`restore`、`versions`、`import`、`export`、`import/:jobId/*`。
- 新增：`POST /courses/:id/publish`（草稿 → 版本 + Offline）、`GET /courses/:id/history`、`POST /courses/:id/prices/:planId/sync-stripe`。

完整端点清单（现有 + 新增）：
- `GET /backoffice/courses`（list，支持 categoryId 筛选）
- `POST /backoffice/courses`（create）
- `GET /backoffice/courses/:id`
- `PUT /backoffice/courses/:id`（updateCourse：learningMode 锁定校验、learningLanguages 只增）
- `PUT /backoffice/courses/:id/localizations/:language`
- `POST /backoffice/courses/:id/lessons`
- `PUT /backoffice/courses/:id/lessons/reorder`
- `PUT /backoffice/courses/:id/lessons/:lessonId`
- `DELETE /backoffice/courses/:id/lessons/:lessonId`（软删除）
- `POST /backoffice/courses/:id/publish`（新增）
- `POST /backoffice/courses/:id/live-status`
- `POST /backoffice/courses/:id/restore`
- `GET /backoffice/courses/:id/versions`
- `GET /backoffice/courses/:id/history`（新增，分页）
- `POST /backoffice/courses/:id/export`
- `POST /backoffice/courses/import` / `import/:jobId/*`
- `POST /backoffice/courses/:id/prices/:planId/sync-stripe`（新增，或并入价格保存）

### 4.2 Portal Integration API（`/api/portal/v1`）

保持 v1 契约冻结；v2 投影继续按开关启用。调整：课程主键对外以 `code`（Course ID）为主，`slug` 为路由别名；Portal 侧 `adminCourseAdapter` 映射时以 `code` 为 `ProductCourse.id`（需与 Portal 团队确认）。

### 4.3 Operations（`/api/backoffice/operations`）

新增 Popular Courses / Discovery Banner 端点（v2 §18 已定义），RBAC 要求 Course PUBLISH。

- `GET /backoffice/operations/popular-courses`
- `PUT /backoffice/operations/popular-courses`（body: `{ items: [{courseId, sortOrder}] }`）
- `GET /backoffice/operations/discovery-banner`
- `PUT /backoffice/operations/discovery-banner`（body: `{ enabled, courseId, localized: {en, zh} }`）
- `POST /backoffice/operations/publish`（Popular Courses / Discovery Banner 各自 Publish）

---

## 5. 前端调整

- `CourseEditorPage`：移除 Publish to UAT / Approve / Go Live 按钮，保留 Publish（生成版本）+ 状态切换（Online/Hidden/Offline）+ Restore + Delete draft。
- 新增 `OperationsPage`（Popular Courses + Discovery Banner），入口 Course Overview 右上角。
- 新增 `HistoryPage`（或 Versions 页底部 History 列表）。
- `CoursePreviewPage`：扩展为学员视角预览（对齐 portal modeling-life 详情页字段：category/title/shortDescription/overview/whatYouLearn/lessons+duration/provides/试看/价格）。
- i18n：新增 `course.publish`、`course.status.*`、`operations.*`、`history.*`、`course.errors.*`、`course.validation.*`。
- 环境标识：页头显示 Sandbox（紫）/Production（红）标签（按 `ENVIRONMENT_LABEL`）。
- 课程详情：3 Tab + 步骤条 + Save/Save & next 线性导航；Content language 切换；Lesson 列表 + Import 菜单；Exhibits 批量上传与编辑抽屉；Preview as learner。
- Trial 页：试看 Lesson 连续选择、截止点、Re-confirm 状态、汇总。
- Pricing 页：套餐列表 + Stripe 同步状态（Failed/Retry）。

---

## 6. 校验规则与错误码

### 6.1 校验三级（PRD §20）

- **Incomplete**：保存时字段标红，对应部分和步骤显示 Incomplete。
- **提示（黄）**：字数超建议长度、4–5 条 "6 recommended" 等，不阻止保存/发布。
- **拦截**：操作当时直接阻止并提示（如 Course ID 重复、包 Course ID 不匹配、时间点超出视频时长、文件列不一致等）。

### 6.2 Publish 门禁（PRD §15.2）

- Course Information 未完成 → 不允许发布，按钮置灰，悬停 "Complete Course Information first"。
- 至少 1 个 Lesson 的 Study & Exploration 完成，否则不允许发布，提示 "Complete at least 1 lesson first"。
- 未完成 Lesson 不在前台显示；未完成 Understanding 的测试不显示；Trial 未完成则不提供试看。

### 6.3 导出门禁（PRD §16.2）

线上版本 3 步必须都完成，否则 Export 不可用，提示 "This version is incomplete. Complete all 3 steps, publish, then export."

### 6.4 错误码（新增 + 现有）

现有错误码保留（`PACKAGE_INVALID_ZIP`、`PACKAGE_NOT_A_COURSE`、`COURSE_MEDIA_NOT_FOUND` 等）。新增：
- `STRIPE_SYNC_FAILED`：Stripe 产品/价格创建失败。
- `COURSE_REFERENCED`：课程/课时被引用，无法硬删除。
- `VERSION_NOT_FOUND`：版本不存在。
- `COURSE_ID_DUPLICATE`：Course ID 已存在（从包新建时）。
- `PACKAGE_COURSE_ID_MISMATCH`：包中 Course ID 与当前课程不一致。
- `TRIAL_RECONFIRM_REQUIRED`：试看截止点需重新确认。
- `OPERATIONS_INVALID`：运营位校验失败（如 featured course 不 Online/Trial）。

---

## 7. History action 枚举

PRD 明确写入 History 的操作（§21）：

| Action | Detail 示例 | 触发 |
|---|---|---|
| `PUBLISH` | `Published Version 4 (Sandbox 3.4)` | Publish |
| `DELETE_DRAFT` | `Draft deleted; live keeps Version N` | Delete draft |
| `RESTORE` | `Restored from Version N` | Restore |
| `EXPORT_PACKAGE` | `Exported Version X.Y · C001_3.4.zip` | Export |
| `IMPORT_PACKAGE` | `Import package · Draft replaced · 文件名` | Import |
| `CHANGE_STATUS` | `Offline → Online · reason` | Change status |
| `OPERATIONS_PUBLISH` | `Popular Courses / Discovery Banner published` | Operations Publish |
| `CREATE_COURSE` | `Created course C001` | 新建课程（建议） |

**不写入**：内容编辑（Save）、试看修改、价格修改（PRD §21 明确）；是否需要另行记录见 §15 Q1。

每条记录字段：`courseId`、`versionNo`（或 null）、`action`、`detail`（Json，含原值/新值/原因/文件名）、`actorEmployeeId`、`requestId`、`createdAt`。

---

## 8. 删除与引用保护

- **课程**：仅软删除（`liveStatus = OFFLINE` + `archivedAt`），不物理删除；Portal 历史记录仍可解析。
- **课时/章节**：软删除（`archivedAt`），保存草稿时通过 `removedLessonIds` 标记（已有）；Publish 后才从网站移除；学员历史进度/测试结果保留。
- **媒体**：仅允许删除未被引用的资产；被视频触发点或文本引用的展品不能删除，提示引用位置（如 "Used in Video 2.1. Remove it there first."）。
- **题目/Reading**：删除需二次确认；有学员作答的 Knowledge Test 题目删除时确认弹窗提示作答人数，历史作答保留。
- **硬删除**（未来）：需先校验无订单/进度/权益引用，否则拒绝并返回 `COURSE_REFERENCED`。
- **不可删除**：版本、学习语言（只能增加）、Learning mode（创建后锁定）。

---

## 9. Operations 细则

- **Popular Courses**：1–6 门，拖拽排序，同一课程不能重复；+ Add course 只列出 Online 课程，已添加置灰；卡片内容读取 Course Information；课程变为 Hidden/Offline 后推荐项保留并标红，提供 Replace，学生端跳过。
- **Discovery Banner**：单例，不轮播；Show banner 开关；featured course 下拉只列出 Online 且 Trial 已启用的课程；中英文文案均必填（超建议长度只提示）；按钮固定进入所选课程 Trial；背景图由开发控制；Banner 预览可切 EN/中文；所选课程变为 Hidden/Offline 或 Trial 关闭时 Banner 停止展示并在后台标出，直到运营更换课程并重新 Publish；Show banner 开启时课程和中英文文案必须填写，否则 Publish 不可用。
- **发布**：修改后点 Publish 确认后立即在本环境网站生效；不设草稿，不生成版本；显示最近发布时间和操作人。
- **运营位不在课程包中**，两环境各自配置。

---

## 10. Portal 学员端对齐

Portal 课程详情页字段与 Admin 编辑器预览一致：category、title、shortDescription、overview、whatYouLearn、lessons（title+duration+description）、试看（trial）、provides（preset/custom）、价格（subscription plan）、总时长、课时数。

- **Admin 编辑器**的"学员视角预览"（`CoursePreviewPage`）应投影相同字段，复用 v2 模型（CourseLocalization/CourseLocalization provides/whatYouLearn/LessonLocalization/videoDurationSeconds）。
- **Portal Integration API** v1 投影（v2 §22.2）继续按开关启用；课程主键对外以 `code` 为主，`slug` 为路由别名；Portal 侧 `adminCourseAdapter` 映射时以 `code` 为 `ProductCourse.id`（需与 Portal 团队确认）。

---

## 11. KS / AI Tutor 协作（不变）

v1 §2.3 结论继续有效：两实体拆分、Admin 单一写入、Portal 只读、共享 DB/service、进程内事件。课程锚点为 `CommerceCourse.id`/`code`。KS `Course.commerceCourseId` 关联不变。AI Tutor 按 Course ID + Lesson ID + 版本号读取已发布内容。每次 Publish 后 AI 模块按新版本更新知识库。

---

## 12. 迁移路线

| 阶段 | 目标 | 主要交付 |
|---|---|---|
| **P0 契约冻结** | 本文档评审通过 | PRD 对齐结论、状态机简化、版本编号、Stripe、删除保护、开放问题结论 |
| **P1a 已完成** | 包导入/导出 + v2 模型 + S3 + 编辑器 | 复用，按 §2 调整状态/版本/价格 |
| **P1b 调整** | 按 PRD 简化流程 | 移除 UAT/approve/go-live、新增 publish、history、operations、Stripe 同步、学员预览、试看/价格不 bump 版本 |
| **P2 迁移与双跑** | SIT→UAT→PROD 课程包晋级 | 复用导入/导出；按 PRD 环境流程 |
| **P3 切换收口** | Portal 只读 Admin；KS 标题来源切换 | v1 §10 P3 |

---

## 13. 测试与验收（PRD §25）

- **环境**：两环境部署同一代码版本；页头显示正确环境标识；Course Sandbox 与正式网站数据完全隔离；Sandbox 下单走 Stripe 沙盒（测试卡，无真实扣款）；Production 走 Stripe 正式；Production 发版后 Sandbox 同步升级。
- **新建与内容**：New course 生成唯一不可修改 Course ID；Learning mode 和 Learning languages 创建后不能修改；学习语言只能增加；从包新建时 Course ID/Lesson ID 与包一致，Course ID 已存在时拒绝；3 步完成状态按 §20 计算；未完成字段标红；Save & next 按 §1.7 顺序；文本模式只把 H1 识别为 LP；Recommended reading 只有英文一份，Type 为 Book/Article/Paper/Other，批量导入按 Lesson ID 匹配，错误行不导入；Import Understanding 按 Lesson ID 匹配，只导入正确行，Lesson 已有 Application Test 时不覆盖；字数超建议长度只标黄不阻止。
- **试看与价格**：试看设置保存后立即在本环境网站生效，不生成版本；Restore 不改变当前试看；Pricing 保存后在本环境 Stripe 创建 Product 和 Price（USD，周期正确，lookup key 正确）；改价生成新 Price、旧 Price 停用；导入包后价格在目标环境 Stripe 自动创建；Stripe 失败时显示 Failed/Retry，不影响发布。
- **草稿与发布**：保存/导入/恢复只改草稿，网站内容不变；Publish 生成版本号并立即生效，草稿变为 No draft，课程状态不变；Sandbox 可发布不完整内容（CI 未完成或无 Lesson 完成时不能发布；未完成 Lesson 不在前台显示；未完成测试不显示；Trial 未完成不提供试看）；Publish 弹窗在有未完成步骤时列出空缺；Notify enrolled learners 默认不勾选；Delete draft 后草稿恢复为线上版本内容，网站不受影响；No draft 或从未发布时按钮置灰。
- **版本**：Sandbox 编号 1.1、1.2…；导出后下一次发布为下一整数系列的 .1；Production 编号 Version 1、2、3…；每个版本显示正确来源；版本不可删除；编号不复用；View 为只读；Restore 后草稿为旧版本内容，发布后生成新版本号来源 "Restored from Version N"，当前试看和价格不变。
- **课程包**：Export 只导出线上版本；线上版本不完整时不能导出；导出后版本显示 Exported；包包含内容/文件/试看设置/价格，不包含学员数据和 Stripe ID；文件名 `CourseID_版本号.zip`；Import 只替换草稿，线上版本不变；Course ID 不一致时拒绝；导入失败时草稿保持原样；Sandbox 导出的包导入 Production 并发布后，前台内容与 Sandbox 测试时一致（逐页核对）。
- **状态**：第一次 Publish 后为 Offline；改为 Online 后上线；之后发布新版本不改变状态；Change status 必须填原因，写入 History；Not published 时不可用；Hidden：列表/搜索/推荐位不出现，已报名学员可继续学习；Offline：所有学员不能进入，数据保留；课程改为 Hidden/Offline 后运营位推荐项失效并标出。
- **学员与数据**：发布新版本后已完成的课程保持已完成；进度按 §1.15 计算；替换视频的 Lesson 播放位置清零；每条学习记录带版本号；运营数据按 Course ID、Lesson ID 跨版本累计。
- **运营位**：Popular Courses 可配置 1–6 门，保留人工顺序；Discovery Banner 按钮固定进入所选课程 Trial；运营位修改需要 Publish 确认后才生效，不生成课程版本。
- **History**：记录 §7 列出的操作，记录不可修改或删除。

---

## 14. 风险

| # | 风险 | 处置 |
|---|---|---|
| 1 | 状态机简化需改动已实现的 publish-uat/approve/go-live | 作为 P1b 任务，先删除路由再新增 publish |
| 2 | 版本编号 fractional 需 schema 变更 | §3 已规划 |
| 3 | Stripe 集成需环境账号与权限 | 提前申请；失败明确报错 |
| 4 | Portal ID 主键（code vs slug）需 Portal 团队确认 | §4.2 / §10 |
| 5 | 课程包大文件传输方式（§24）需开发决策 | 建议服务端存储复制，Operator 不经手大文件 |
| 6 | 学习语言添加后补齐材料的完成度计算 | 复用 Incomplete 机制 |
| 7 | Publish 后进度重算与 AI 知识库更新耗时 | §24 待确认同步/后台任务 |

---

## 15. 待开发确认事项（PRD §24，最终确认）

**环境与课程包**
1. 两套版本编号方式的实现（建议一个配置项）；Sandbox "导出后进入下一系列" 的计数方式。
2. 课程包中大文件（视频、展品）的传输方式：建议课程包只带内容数据和文件清单，导入时由服务端从 Sandbox 存储复制文件到 Production 存储；不可行时打包全部文件，支持大文件上传和断点续传。
3. 导入时，Course ID、Lesson ID 以外的 ID（Exhibit、题目、LP）是否保持不变。
4. 视频存储与分发方案，含中国市场是否需要国内点播或 CDN。
5. Sandbox 测试账号的预置和学习数据重置方式。
6. AI Tutor 在 Sandbox/Production 分别可用，知识库按本环境已发布的版本生成；由开发调通。

**价格与支付**
7. Stripe Product/Price 的创建与更新方式；lookup key 命名规则；Price 的停用时机。
8. 改价后已订阅学员的处理（继续按原价，或下一周期按新价）——需业务确认。
9. 按课程订阅与现有分类套餐（category plan）的关系，以及前台展示方式——需与订阅管理 PRD 对齐。
10. 微信支付、支付宝对自动续费订阅的支持情况；中国用户的订阅支付方式。

**学员数据**
11. 跨版本时 Lesson 内 LP 进度的匹配方式（LP 内部 ID 或 LP 序号）；原则：已完成的课程和 Lesson 保持完成。
12. Publish 后进度重算和 AI 知识库更新的执行方式（同步或后台任务）及耗时。
13. 试看和价格的修改是否需要单独的修改日志（PRD §21 提出）。

**内容（沿用 v1.0）**
14. 3D 查看器支持的格式和模型大小上限；视频是否转码、自适应码率；各类文件大小上限；图片自动压缩与缩略图裁切。
15. 后台 Preview as learner 能否复用前台展品查看器组件。
16. Course ID 是否保留字母前缀（如 C001）。
17. Google Docs 粘贴和 .docx 导入时 H1 样式的识别方案。
18. 版本快照的存储，以及未更换文件在各版本间共用的实现。

**本设计新增待确认**
19. History 是否记录内容编辑/试看/价格修改（PRD §21 默认不写入，§24 待确认）。
20. Lesson 软删除字段：新增 `archivedAt` 还是复用 `removedLessonIds` 机制。
21. Popular Courses / Discovery Banner 是否需要独立 History 记录（当前纳入 `OPERATIONS_PUBLISH`）。

---

## 16. 附录：PRD 章节 ↔ 架构映射

| PRD 章节 | 架构落点 |
|---|---|
| 1 产品目标 | §0/§11 |
| 2 产品范围 | §1.4 |
| 3 环境与角色 | §1.1/§1.2 |
| 4 术语和数据层级 | §1.3 |
| 5 整体流程 | §1.5 |
| 6 信息结构与导航 | §1.6 |
| 7 页面清单 | §5 |
| 8 Course Overview（CM01） | §5（CourseManagementPage） |
| 9 新建课程（CM02–CM04） | §5 / §1.13 |
| 10 课程详情通用规则 | §1.7 |
| 11 Course Information（CM05） | §1.8（v2 CourseLocalization） |
| 12 Study & Exploration（CM06a–d） | §1.9（Lesson/Exhibit/LearningPoint） |
| 13 Understanding（CM07） | §1.10（KnowledgeQuestion/ApplicationTest） |
| 14 Trial 与 Pricing | §1.11 / §2.3/§2.4 |
| 15 草稿、发布与版本 | §1.12 / §2.1/§2.2 |
| 16 课程包导出与导入 | §1.13 / §7（复用 P1a） |
| 17 课程状态 | §1.14 / §2.1 |
| 18 版本更新对学员的影响 | §1.15 / §10 |
| 19 Operations（CM18、CM19） | §1.16 / §9 |
| 20 校验规则 | §6 |
| 21 History | §7 / §2.5 |
| 22 删除与引用保护 | §8 / §2.6 |
| 23 异常处理 | §6.4 / §2.7 |
| 24 待开发确认事项 | §15 |
| 25 验收标准与测试要点 | §13 |
| 26 后续阶段 | §12 / §1.23 |

---

**本设计为最终确认版。确认后按 §12 路线进入 P1b 开发。**
