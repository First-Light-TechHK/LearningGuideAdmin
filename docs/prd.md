Learning Guide Course Management PRD
v2.0 · 2026-10-30 · Sandbox 与 Production
---
目录
1 产品目标
2 产品范围
3 环境与角色
4 术语和数据层级
5 整体流程
6 信息结构与导航
7 页面清单
8 Course Overview（CM01）
9 新建课程（CM02–CM04）
10 课程详情通用规则
11 Course Information（CM05）
12 Course Content · Study & Exploration（CM06a–d）
13 Course Content · Understanding（CM07）
14 Trial 与 Pricing
15 草稿、发布与版本
16 课程包导出与导入
17 课程状态（上下架）
18 版本更新对学员的影响
19 Operations（CM18、CM19）
20 校验规则
21 History
22 删除与引用保护
23 异常处理
24 待开发确认事项
25 验收标准与测试要点
26 后续阶段

本 PRD 定义 Learning Guide Back Office 中 Course Management 模块的需求，内容包括：
- 课程内容配置、价格配置
- 草稿与发布、版本管理、课程包导入导出
- 上下架、运营位
- Sandbox 与 Production 两套环境的使用规则
界面与交互以 Figma 设计稿为准，各章节注明对应的设计稿编号（CM 为页面，S 为状态图）。本版替代 v1.0。
| 字段 | 内容 |
| --- | --- |
| 版本 | v2.0 |
| 日期 | 2026-10-30 |
| 范围 | MVP，桌面 Web 后台 |
| 后台界面语言 | 英文（英式拼写），中文（随整个backoffice语言切换） |
| 设计稿 | Figma：course-management（https://www.figma.com/design/Z6GJpeiHIsRJYVPQvfsgTz/course-management），页面 CM01–CM19（含 CM11b、CM12b），状态图 S01–S18。画布最上方的 "Notes for development" 是本 PRD 的摘要。 |
| 执行关系 | 本 PRD 定义后台业务规则。学生端的详细体验以 Study、Understanding、Exploration、My Learning 等前台 PRD 为准。Trial 规则与 Visitor Trial PRD 不一致时，以本 PRD 为准。 |

字段
内容
版本
v2.0
日期
2026-10-30
范围
MVP，桌面 Web 后台
后台界面语言
英文（英式拼写），中文（随整个backoffice语言切换）
设计稿
Figma：course-management（https://www.figma.com/design/Z6GJpeiHIsRJYVPQvfsgTz/course-management），页面 CM01–CM19（含 CM11b、CM12b），状态图 S01–S18。画布最上方的 "Notes for development" 是本 PRD 的摘要。
执行关系
本 PRD 定义后台业务规则。学生端的详细体验以 Study、Understanding、Exploration、My Learning 等前台 PRD 为准。Trial 规则与 Visitor Trial PRD 不一致时，以本 PRD 为准。

核心结论
- 两套环境，同一套代码。
- Sandbox 由三部分组成：Course Sandbox（前台）、Admin Sandbox（后台）、Stripe 沙盒。
- Production 由三部分组成：正式网站、正式 Admin、Stripe 正式账号。
- 两边代码完全一致，差异只在配置：环境标识、网站地址、Stripe key、版本编号方式。不做某个环境专属的功能。
- 后台全部由我方 Operator 操作。 客户的 Course Creator、Graphic Designer 等角色在 Google Drive / Google Sheet 中交付内容，在 Course Sandbox 前台测试，在线下 Checklist 中确认。后台不设审批、通知等流程。
- 内容只在 Sandbox 创建和编辑。 Sandbox 测试通过后，导出课程包，导入 Production 发布。Production 不手动改内容，这是操作规则，系统不做限制。
- 草稿 + 发布。 编辑、导入、恢复都只改草稿（Draft），保存不生成版本。点 Publish 后，草稿在本环境网站生效并生成版本号。
- 版本编号。
- Sandbox 每次发布加 0.1（1.1、1.2…），导出后进入下一个系列（2.1…）。
- Production 每次发布生成下一个整数版本（Version 1、2、3…），并记录来源。
- 版本不可删除。回退 = 把旧版本恢复到草稿，再发布成新版本。
- 状态与版本分开。 课程状态有 Not published / Online / Hidden / Offline 四种。首次发布后为 Offline，Operator 手动改为 Online 才上线；改状态不生成版本。
- 试看配置和价格随课程包带入，导入后可单独修改，不生成版本。价格为美元，由 Admin 调用 Stripe 接口在本环境的 Stripe 账号中自动创建。
# 1 产品目标
Course Management 用于配置学生端所需的全部课程内容，并管理课程从创建、测试、上线、更新到下架的全过程。它是学生端课程卡片、课程详情页和学习流程的唯一课程数据源。
- 用统一的 Course ID 管理课程信息、Lesson、学习内容、测试、试看、价格和版本。
- 新课程或课程更新在上线前，可以在与正式环境一致的 Sandbox 中跑通整套流程：内容、功能、试看、订阅、支付、AI Tutor。
- 测试通过的内容原样进入 Production，不重复录入。
- 保存每个发布过的版本，支持查看和恢复。
- 发布、导入导出、上下架、版本操作可追溯。
AI Tutor 的对话配置、知识库和 Application Test 的 AI 评估逻辑由 AI 模块负责。AI 模块按 Course ID、Lesson ID 和版本号，读取本环境已发布的课程内容。
# 2 产品范围
## 2.1 MVP 包含
- 课程列表与 Category 筛选；新建课程（空白新建、从课程包导入）；Course ID。
- 课程内容 3 步配置：Course Information、Course Content、Trial。
- Understanding 批量导入（全部 Lesson）、单 Lesson 导入；Recommended reading 批量导入。
- 添加学习语言。
- 课程价格（订阅套餐，美元）与 Stripe 产品、价格的自动创建。
- 草稿、Publish、Delete draft。
- 版本管理：版本号、版本列表、查看、恢复（Restore）。
- 课程包：导出（Sandbox）、导入到已有课程、从课程包新建课程。
- 状态切换：Online / Hidden / Offline。
- History：本课程的关键操作记录。
- Operations：首页 Popular Courses、课程发现页 Discovery Banner。
- 两套环境的配置项。
## 2.2 MVP 不包含
- 后台审批流程、上线前预览（Live Preview）、Super User 预览。客户在 Course Sandbox 前台测试。
- 系统内通知 Course Creator 等客户角色（线下沟通）。
- 版本删除、版本差异对比、一键把线上切回旧版本。
- 导入检查报告（Operator 在后台页面中自行检查空缺项）。
- 环境之间自动同步内容（只通过课程包导出导入）。
- 课程搜索、统计看板；History 的筛选和导出。
- 自动保存；后台视频播放器。
- 删除学习语言；创建后修改 Learning mode。
- 运营位定时发布；Discovery Banner 背景图配置（由开发发版控制）。
- 中文后台界面；细分的后台权限。
# 3 环境与角色
## 3.1 两套环境
|  | Sandbox | Production |
| --- | --- | --- |
| 组成 | Course Sandbox（前台）+ Admin Sandbox（后台）+ Stripe 沙盒 | 正式网站 + 正式 Admin + Stripe 正式账号 |
| 用途 | 新课程和课程更新的完整测试：内容、功能、试看、订阅、支付、AI Tutor | 学员正式使用 |
| 谁用 | Operator 配置；客户角色用测试账号在前台测试 | 学员；Operator 导入、发布、上下架 |
| 内容 | 在这里创建、编辑 | 只通过课程包导入，不手动编辑（操作规则） |
| 数据 | 与 Production 完全隔离；测试账号、订单、学习记录不进入正式数据 | 正式数据 |


Sandbox
Production
组成
Course Sandbox（前台）+ Admin Sandbox（后台）+ Stripe 沙盒
正式网站 + 正式 Admin + Stripe 正式账号
用途
新课程和课程更新的完整测试：内容、功能、试看、订阅、支付、AI Tutor
学员正式使用
谁用
Operator 配置；客户角色用测试账号在前台测试
学员；Operator 导入、发布、上下架
内容
在这里创建、编辑
只通过课程包导入，不手动编辑（操作规则）
数据
与 Production 完全隔离；测试账号、订单、学习记录不进入正式数据
正式数据

同一套代码，只有配置不同
| 配置项 | Sandbox | Production |
| --- | --- | --- |
| 环境标识（后台页头标签） | Sandbox（紫色） | Production（红色） |
| 网站地址 | 测试网站地址（如 sandbox.learningguide.com） | 正式网站地址 |
| Stripe key | Stripe 沙盒（测试模式） | Stripe 正式 |
| 版本编号方式 | 小号（X.Y），第 15 章 | 整数（Version N），第 15 章 |

配置项
Sandbox
Production
环境标识（后台页头标签）
Sandbox（紫色）
Production（红色）
网站地址
测试网站地址（如 sandbox.learningguide.com）
正式网站地址
Stripe key
Stripe 沙盒（测试模式）
Stripe 正式
版本编号方式
小号（X.Y），第 15 章
整数（Version N），第 15 章

- 后台所有页面、按钮在两个环境中一样。设计稿中按常用场景标注环境：内容编辑页标 Sandbox，总览、版本页、运营位多数标 Production。
- 不在代码中按环境隐藏功能。例如 Production 中也有 Export package，但不使用（第 16.2 节）。如果开发认为某个功能需要按环境隐藏，用配置项实现，并在评审时提出。
- 代码同步： Production 每次发版，Sandbox 同步升级到同一代码版本。Sandbox 不跟随 UAT 等开发测试环境。如果新课程依赖尚未上线的新功能，该课程的测试在开发的 UAT 中和功能一起进行，待功能发版后再走本流程。
## 3.2 角色
| 角色 | 所属 | 职责 |
| --- | --- | --- |
| Operator | 我方 | 后台全部操作：创建课程、上传内容、配置试看和价格、发布、导出导入、上下架、恢复版本、运营位、Stripe 配置检查。 |
| Course Creator | 客户 | 负责一门课程的内容；在 Course Sandbox 前台完成全部测试；在 Checklist 中确认测试通过。 |
| Graphic Designer、Video & Text Manager | 客户 | 在 Google Drive 交付封面、展品、视频、文本等文件。 |
| LLM Manager | 客户 | 根据课程信息在其他系统中准备 AI Tutor 知识库，不使用本后台。 |

角色
所属
职责
Operator
我方
后台全部操作：创建课程、上传内容、配置试看和价格、发布、导出导入、上下架、恢复版本、运营位、Stripe 配置检查。
Course Creator
客户
负责一门课程的内容；在 Course Sandbox 前台完成全部测试；在 Checklist 中确认测试通过。
Graphic Designer、Video & Text Manager
客户
在 Google Drive 交付封面、展品、视频、文本等文件。
LLM Manager
客户
根据课程信息在其他系统中准备 AI Tutor 知识库，不使用本后台。

- 后台只有 Operator 使用，本期不做细分权限。其他后台角色按 Back Office 统一权限矩阵，对本模块只读。
- Course Sandbox 提供测试账号：每个客户角色至少一个，可正常订阅（用 Stripe 测试卡）和学习。测试账号由开发预置，可重置学习数据。
# 4 术语和数据层级
| 术语 | 定义 |
| --- | --- |
| Course | 课程主体，拥有唯一且不可修改的 Course ID。 |
| 草稿（Draft） |  |
|  |  |
|  |  |
|  |  |
|  |  |
|  |  |
|  |  |
|  |  |
|  |  |
|  |  |
|  |  |
|  |  |

术语
定义
Course
课程主体，拥有唯一且不可修改的 Course ID。
草稿（Draft）