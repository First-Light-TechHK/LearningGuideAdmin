# ops 申请邮件 / 工单草稿

> 用途：把 `docs/sandbox/provisioning-request.md` §7 的开放问题整理成可直接发出的申请。
> 发送人：Learning Guide 开发侧（Jackcao / LEO 指定联系人）。
> 副本：LEO、产品负责人、付款负责人、DNS 负责人。
> 本文不含任何密钥；所有引用材料都在本仓库（private）内。
> 来源：2026-11-19 从 LearningGuideSandbox 仓库 `docs/ops-request-draft.md` 合并进 Admin 仓库（F4 合并完整性）；引用已改为 Admin 仓库的 `docs/sandbox/` 文档，代码缺口状态按当前分支同步。

---

## 邮件正文（可直接复制）

**主题：【申请】Learning Guide Sandbox 环境资源与外部账号 — 需决策项请于 2026-11-20 前回复**

各位：

Learning Guide 的课程生产流程要改为「Sandbox 创作与验收 → 导出课程包 → 生产只导入」，为此需要搭建独立的 Sandbox 环境（Course Sandbox 前台 + Admin Sandbox 后台 + Stripe 沙盒），与生产数据完全隔离，运行同一套代码。

开发侧已完成：资源申请单（含隔离要求与验收标准）、环境变量模板（仅占位符）、环境矩阵、代码就绪度与缺口清单，见本仓库：

- `docs/sandbox/provisioning-request.md` — 完整资源清单（§2）、密钥引用名（§3）、分步搭建与验收（§5）、代码侧就绪度与缺口 G1–G14（§6）
- `deploy/sandbox.example.env` — 两服务环境变量占位模板（全模块、全角色；需密钥项由 ops 注入）
- `docs/sandbox/environments.md` — 环境矩阵与分支契约

**请各组按下面的清单行事**；需要决策的问题都给了建议，请回邮件确认或修改。期望时间默认 **2026-11-20**；如某项有硬依赖可顺延，但请注明新的日期，以便排期。

### 请 ops（AWS 平台）做的事

1. 拍板 AWS 账号归属：现有账号内独立 CloudFormation 栈，还是新账号？开发侧建议**现有账号内独立栈**（命名统一带 `sandbox`，隔离靠命名空间与 IAM）。
2. 按 `docs/sandbox/provisioning-request.md` §2.1/§2.2 创建资源：VPC 子网（建议 172.31.68/69，请先核对不与 SIT 64/65、UAT 66/67 冲突）、NAT、S3 Endpoint、安全组、RDS `learning-guide-sandbox` 与 `learning-guide-admin-sandbox`（PostgreSQL 16.13、加密、私有、备份 7 天）、两个 S3 桶、两个 App Runner 服务、AutoScaling、CloudWatch 告警。
3. 按 §3.4 建立 Secrets Manager 命名空间 `learning-guide/sandbox/*` 与 `learning-guide/admin/sandbox/*`；真实值由各提供方给出后由 ops 注入，**绝不经过仓库、GitHub 或邮件正文**。Sandbox 全模块、全角色启用：Helpdesk / AI Tutor / Study Group 的密钥同样需要创建；未创建时功能按设计降级（Helpdesk 503、AI 未配置错误），不影响课程管理。
4. 按 §4 在两仓库建立 sandbox 部署变量（`ADMIN_SANDBOX_APP_RUNNER_SERVICE_ARN`、`SANDBOX_APP_RUNNER_SERVICE_ARN` 等）与专用 CI IAM 用户（只允许 sandbox 服务的 Describe/List/StartDeployment）。
5. 部署时注意两个已核对的坑（§6 G11/G12）：Admin 的 `AUTH_TOKEN` 需指向 `admin_api_key` secret（provision 脚本已自动映射）；Admin RDS 备份保留设 7 天（脚本已按 sandbox 默认 7 天）。

### 请 DNS 负责人做的事

6. 确认两个域名并准备添加记录：`sandbox.ilovelearningguide.com`、`admin.sandbox.ilovelearningguide.com`。记录值由 ops 在 App Runner 自定义域名创建后从 `describe-custom-domains` 输出提供，请收到后当天发布。

### 请产品 / 付款负责人做的事

7. Stripe：确认测试账号方案（开发侧建议**独立测试账号**，避免与 SIT/UAT 的 webhook 与对账混用）；开通后由谁在测试账号里创建 8 个订阅价格（Everything + 3 个 Category × 6/12 个月）并提供 `sk_test_` 密钥给 ops 注入。
8. 微信：申请一个新的 WeChat 网站应用（按 DEV/SIT/UAT 一环境一应用的惯例），授权回调域 `sandbox.ilovelearningguide.com`；AppID/Secret 由负责人提供给 ops 注入。
9. 测试账号身份：为每个客户角色（Course Creator 等）准备至少 1 个可收件邮箱与 1 个可扫码微信账号，清单只放密码管理器。
10. OpenRouter：AI Tutor 已启用，请确认独立 API key 与月度预算；key 由产品/运维提供给 ops 注入（Q9）。

### 请产品 / 运营负责人决策（影响搭建参数）

11. 邮件通道：首期是否共用现有 163 SMTP（发件人 `learningguide@163.com`，主题加 `[Sandbox]` 前缀）？SES 仍处 sandbox 模式，不能作主通道。
12. 数据重置策略：确认「例行只重置测试学员数据（订单/订阅/权益/学习记录），课程内容保留；季度可整栈重建」是否可接受，以及重置执行人。
13. Study Group（LiveKit）已随全模块启用；请确认 LiveKit 凭据与是否纳入本轮验收（未配置时直播间不可用）。
14. 代码同步：确认「每次 Production 发版后，`sandbox` 分支快进到同一 SHA，由发布负责人登记」这一机制（Sandbox 是 UAT 同码的隔离容器；修复合入上游 dev 后随下一次生产发布进入 sandbox）。

### 请开发侧（我们自己）按计划做的事

15. 代码侧状态（详见 `docs/sandbox/provisioning-request.md` §6）：
    - **本分支已完成**：G3/G4（Admin 环境枚举与 provision 支持 sandbox）、G5（Admin 部署工作流模板已提供，部署前安装）、G10–G12；
    - **Portal 工作区已实现、待提交/部署验证**：G6/G7/D10（`isManagedEnvironment()` 识别 SANDBOX、`environments.mjs` 注册 SANDBOX 条目、`provision-uat.mjs` sandbox tier）；
    - **随 Part C 集成完成**：G1/G2（能力/来源强制接线，默认 off）；G8（Portal 消费 Admin 课程投影）另立项；
    - **外部前置**：`deploy/sandbox-bootstrap.cjs` 缺失（Portal `--bootstrap` 于 AWS 调用前 fail-closed）。

---

**期望时间汇总**：Q1–Q14 请于 **2026-11-20** 前回复；资源创建建议在决策确认后一周内启动（目标 2026-12 上旬 Sandbox 可用）。

有任何问题直接回复本邮件。开发侧已就绪的材料：

- 资源申请单（含隔离与验收）：`docs/sandbox/provisioning-request.md`
- 环境变量模板：`deploy/sandbox.example.env`
- 验收清单与 smoke 脚本：`docs/sandbox/acceptance-checklist.md`、`scripts/sandbox-smoke.mjs`
- AWS 就绪手册：`docs/sandbox/aws-readiness.md`
- 代码就绪度与缺口（G1–G14）：`docs/sandbox/provisioning-request.md` §6

谢谢。

---

## 工单版（若走工单系统，逐项拆单）

| 工单 | 标题 | 执行方 | 依赖 | 期望完成 |
|---|---|---|---|---|
| T1 | 决策：AWS 账号归属（现有账号独立栈 vs 新账号） | LEO/ops | — | 2026-11-20 |
| T2 | 决策：域名与 DNS owner 确认 | 产品/DNS | T1 | 2026-11-20 |
| T3 | 创建 Portal Sandbox 基础设施（栈 learning-guide-sandbox） | ops | T1 | 决策后一周 |
| T4 | 创建 Admin Sandbox 基础设施（RDS/桶/secrets/App Runner） | ops | T1 | 决策后一周 |
| T5 | 域名记录发布与 HTTPS 验证 | DNS/ops | T2/T3/T4 | T5 前 |
| T6 | Stripe 测试账号与 8 个价格 | 付款负责人 | — | T3 前 |
| T7 | WeChat 网站应用申请 | 产品 | — | T3 前 |
| T8 | 测试账号清单（邮箱/微信） | 产品 | — | 验收前 |
| T9 | 邮件通道确认（163 SMTP 复用） | 产品/ops | — | 2026-11-20 |
| T10 | 数据重置策略确认 | 产品 | — | 2026-11-20 |
| T11 | OpenRouter key + 预算（AI Tutor 已启用） | 产品/eng | — | 部署前 |
| T12 | GitHub 变量与 CI 用户（两仓库 sandbox） | ops/eng | T3/T4 | 部署前 |

> 本文是草稿：发送前请由 LEO 过目收件人范围（是否抄送客户方、是否发往外部邮箱）。
