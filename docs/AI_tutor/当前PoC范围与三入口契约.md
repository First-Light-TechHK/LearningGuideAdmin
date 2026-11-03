# AI Tutor 当前 PoC 范围与三入口规划

> 2026-11-02；依据用户两次范围确认。本文是规划补充，不代表代码已接入。

## 1. “PoC 材料”具体指什么

| 材料 | 当前用途 | 不能据此宣称 |
|---|---|---|
| 原先提供的十份 KS_WP1 DOCX（K1/K2 为相同文件） | 架构、选卡、Validator、模型基准、Fluency、科学与历史原型的设计参考；清单和差异见根目录 `AI_Tutor_原文核对与规划依据.md` §1 | 本仓库已拥有相同模块、课程卡包或原报告模型成绩 |
| `知识库内容/Modeling Life 精华提炼（覆盖全书七章）.md` | 本期一门数学建模课程的知识测试文本；章节概念、公式、常见误区和切分建议可供测试样本设计 | 摘要已进入某个 Live Release，或所有论断和习题已通过课程专家审核 |
| Modeling Life 课程现有 Knowledge / Release | 实际 Tutor 请求应绑定本仓库的课程和不可变 Release；内容范围以实际已导入版本为准 | 本地摘要与数据库中的版本自动相同 |
| 原书 PDF、课程素材与其他 PoC 演示 | 后续核对来源和扩展的候选材料 | 自动获批成为正式教学证据 |

工程目标是**Lecture/Socratic 问答稳定调用、受控回答、可追踪失败**。本期只用 Modeling Life 一门课程做知识和工程回归。BackOffice AI Tutor 已有 Set Live 的 Release，本期以该 Live Release 作为测试知识库；具体测试方法由用户后续给出。现阶段没有真实学员，派生内容标记为 PoC 测试用途。原先计划中的 Weimar、GW/EP/AL 多域、十段 Fluency 对话和多模态实验保留为后续候选；已写入仓库的早期纯函数不计入本期完成范围。

## 2. 三个业务入口及本期优先级

| 入口 | 触发与主体 | 教学/评测行为 | 本期会话范围 |
|---|---|---|---|
| Course → Ask AI Tutor（本期） | 测试账号在课程/课时提问 | Lecture 或 Socratic，由现有界面/配置选择；知识来自 BackOffice 已 Set Live 的 Release | 个人测试会话，按账号、课程、Release 隔离 |
| Group Study → `@AI Tutor`（本期） | 测试房间消息触发 | 固定使用该课程 Lecture 提示词和模型配置 | 房间测试会话，按 room/session、课程、Release 隔离 |
| Assessment → 习题评测（后续） | 学生提交 application 书面答案 | 独立评测任务；本期不设计评分标准、不开发评测链路 | 后续按题目和 attempt 定义 |

本期两个问答入口共用课程/Live Release 解析、知识来源、Provider 和教学编排；个人与房间各自保留身份、限流和会话边界。Assessment 后续单独设计，不把评分工作混入 Lecture/Socratic 问答交付。

**已核实的现状**：Portal `app/api/ai-tutor/route.ts` 将个人模式映射为 lecture/socratic，并保存显示用 conversation；`modules/group-study/runtime.ts` 调 `streamTutorText` 时固定 `mode: "lecture"`、`channel: "study-group"`。KS 学员 DTO 已有 channel 分桶，但没有服务端 Tutor 会话。Portal 同时有课时 `knowledge`/`application` assessment 路由以及用于对话试跑的 `app/api/dialogue/assessment/route.ts`；这些入口不能仅凭名称混成同一个习题评测 API。当前 KS 的 ASSESSMENT Prompt 配置也不意味着学生习题评测链路已完成。

## 3. Modeling Life 本期知识切面

摘要覆盖七章：状态与变化律、导数/积分、平衡和稳定、振荡、混沌、线性代数、多变量系统。可供之后设计问答样本的知识点包括：

1. 状态变量与参数、状态空间轨迹与地理位置的区别；变化方程中增加/减少项及单位。
2. SIR 的接触项和守恒假设；Euler 一步更新与步长近似误差。
3. 平衡条件 `X'=0`、局部稳定判据及线性化失效边界。
4. 振荡、混沌、特征值与 Jacobian 等后续章节用来源定位样本验证检索覆盖，不默认要求 Tutor 在无题目参数时演算。

这些知识点来自本地摘要；实际问答只使用 BackOffice 当前 Live Release 中确实存在的内容。测试问题、步骤及通过标准待用户后续给出。

## 4. P3/P5 本期交付与后续测试

- P3 先把两个 Tutor 问答入口接到同一受控教学链。个人会话与房间会话隔离，Lecture/Socratic 仅个人可选，房间固定 Lecture。Assessment 请求、评分和成绩记录移至后续阶段。
- 兼容现有两个 chat-stream 路径和 Portal/Group Study 的展示行为。新会话不信任浏览器传入的 userId、房间 ID 或 Release；由各自服务端身份与课程数据解析。
- P5 本期只以 Modeling Life 的 BackOffice Live Release 作为测试知识库，验证两个问答入口。具体测试步骤和判定由用户后续提供；当前只预留知识来源、模式、错误和调用记录的观察点，不先行宣布通过标准。
- Lecture/Socratic 的输出差异及 Group Study 的 Lecture 固定性分别观察；习题评测不在本期验收内。工程 fixtures/假 Provider 只能说明工程行为，不代表真实模型教学质量。
- 本期不设历史、多科学域、图像/仿真或十段 Fluency 的通过门槛；相关早期代码只作后续基础，不计本期完成率。

## 5. 已确认事项与后续信息

Assessment 将来主要评测课时 **application 书面答案**；评分标准本期暂不考虑。现有 `knowledge` 客观题和 `dialogue/assessment` 试跑工具不纳入本期 Tutor 问答改造。

当前全部处于测试阶段，没有真实学员。BackOffice 已 Set Live 的 Release 是本期知识源，测试方式由用户后续提供。正式学员会话、数据保留/删除、Assessment 标准和生产启用时再按 `P3_Schema_Proposal.md` 细化；当前问答规划没有新的确认门槛。
