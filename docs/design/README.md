# 设计稿对照（BackOffice）

设计源：Figma `Learning Guide YL` / 画布 `674:1186`（后台：Portal+Student+Reporting+HelpDesk）
文件 Key：`sxro3x6YXENJvjhGExmlQ7`

导出的画板 PNG 放在 `docs/design/figma/`，节点树快照放在 `docs/design/674-1186.metadata.json`。

课程管理设计源：Figma `course management` / 画布 `Page 1`（`0:1`）
文件 Key：`Z6GJpeiHIsRJYVPQvfsgTz`；37 个画板（CM 主流程 + S 状态细则）导出到
`docs/design/figma/course-management/`，画板清单见同目录 `manifest.json`，节点树快照为 `0-1.metadata.json`。

课程管理的矢量图标（100 个，几何取自设计稿）在 `docs/design/figma/course-management/icons/`：
`*.svg` + `manifest.json`（尺寸/节点/颜色/是否可着色/出处画板）+ `preview.html` + `_overview.png`，
说明见该目录 `README.md`。后续 Course 功能页实现须严格参照设计稿（含矢量图标）。

## 页面 ↔ 画板对照

| PRD 页面 / 路由 | 对应画板 | 状态 |
|---|---|---|
| 登录 `/[locale]/sign-in` | `1 BackOffice Login`（771:551） | 已按图实现 |
| 共享外壳：顶栏 / 侧栏 / 员工下拉 | `1 Backoffice Menu & Role`（761:236） | 已按图实现 |
| 员工账号 `/[locale]/settings/employee-account` | `1 Backoffice Employee Account`（778:620） | 已按图实现 |
| 新增员工弹窗 | `1 Backoffice Employee Account add`（814:1003） | 已按图实现 |
| 编辑员工弹窗 | `1 Backoffice Employee Account Edit`（814:1216） | 已按图实现 |
| 支付网关 `…/settings/payment-gateway` | 无独立画板 | 沿用卡片 / 子导航规范 |
| 通知配置 `…/settings/notification-configuration` | 无独立画板 | 沿用卡片 / 子导航规范 |
| 忘记密码 / 重置密码 / 激活账号 | 无独立画板 | 复用登录页认证外壳 |
| 课程及其它模块占位页 | 无独立画板 | 沿用外壳与卡片规范 |

## 脚本

```bash
# 重新导出画板 PNG（需要 .figma-token，只读 file_content:read）
node scripts/figma-export.mjs

# 导出其它文件 / 画布（如课程管理）
node scripts/figma-export.mjs --file Z6GJpeiHIsRJYVPQvfsgTz --node 0:1 --out docs/design/figma/course-management

# 导出课程管理矢量图标（几何取自设计稿，重建为独立 SVG）
node scripts/figma-icons.mjs

# 打印某画板的规格表（几何 / 填充 / 圆角 / 自动布局 / 字体）
node scripts/figma-spec.mjs 778:620

# 打印状态点、分页器、操作列等细节节点
node scripts/figma-detail.mjs

# 下载画板里的位图素材（如登录页背景）
node scripts/figma-asset.mjs "Background Image"

# 本地起一个静态服务，按 1:1 查看导出的 PNG
node scripts/figma-view-server.mjs   # http://localhost:4599/
```

## 关键设计数值（画板宽 1672）

| 项 | 值 |
|---|---|
| 画布底色 | `#f7fafc`；设置子导航右侧留白 `#f9fbfe` |
| 主色 | `#1d6bff`；激活描边 `#3b82f6`；浅底 `#e7eeff` / `#eff6ff` / `#e8f0ff` |
| 文字 | 标题 `#1e293b`、正文 `#334155`、次级 `#475569`、说明 `#64748b`、占位 `#94a3b8` |
| 顶栏 | 高 68，logo 42×42 圆角 10，品牌 20px/700，下缘 1px 黑 10% |
| 侧栏 | 宽 280，首项顶距 23，菜单项 256×50 圆角 8，内距 12，图标 20，文字 15/500 |
| 侧栏激活 | 底 `#1d6bff` 10%（≈`#e8f0ff`），文字/图标 `#1d6bff` 600 |
| 折叠按钮 | 24×24 @(244,76)，图标描边 `#6b7280` |
| 员工下拉 | 220 宽，圆角 12，行高 46，内距 14/16，行间 1px `#e5e7eb` |
| 设置子导航 | 宽 276，内距 12，项 252×50 圆角 6，激活底色 `#e7eeff` |
| 主卡片 | 1082×852，圆角 12，内距 28/32/24，标题 22px/700 |
| 筛选 | 搜索 494×34，下拉 250×34，描边 `#e2e8f0`，间距 12 |
| 表格 | 表头高 50（`#f6f8fa`，圆角 6），行高 50 + 1px `#e2e8f0`，列宽 300/180/140/240/158 |
| 状态点 | 8×8：启用 `#22c55e`、待激活 `#eab308`、停用 `#94a3b8` |
| 行内菜单 | 160 宽，圆角 8，行高 32，描边 `#e2e8f0` |
| 分页 | 按钮 30×30 圆角 6，当前页 `#eff6ff` + `#1d6bff` |
| 弹窗 | 宽 832，圆角 12；头 88（24/28/20/28）、体（24/28，间距 20）、底 84（20/28/24/28），头底/底顶各 1px `#e2e8f0` |
| 弹窗控件 | 输入框 44 高、圆角 8、描边 `#e2e8f0`；分段 382×44 圆角 8；关闭键 32×32 `#f8fafc` |
| 遮罩 | `#0f172a` 45% |
| 登录页 | 顶栏 64；内容顶距 96；卡片 424 宽内距 36 圆角 16；标题 36/700；输入 352×42 描边 `#d1d5db` |

## 已按图落地的页面

| 页面 | 落地要点 |
|---|---|
| 登录 `sign-in` | 64 顶栏 + 背景图 + 徽标/标题/副标题（424 宽区块内**居中对齐**，同 Figma textAlign=CENTER）+ 424 白卡；邮箱右侧绿色通过标记 / 红色感叹号；忘记密码链接 13/500 |
| 共享外壳 | 顶栏横跨整宽，侧栏在顶栏之下；8 个菜单图标全部使用 Figma 原始矢量（book-line / stack-line / loader-fill / booklet-line / dashboard-2-line / user-settings-line / book-read-line / settings-2-line）；折叠按钮 24×24；员工下拉含两条分隔线；折叠状态按账号落库 |
| 员工账号 | 标题区 + Add Employee（37 高）+ 搜索/角色/状态筛选 + 8 行表格 + 分页；操作列 ⋮ 菜单 160 宽 |
| 新增 / 编辑员工 | 832 弹窗，关闭键为 Figma 的 x-circle（16 描边 2 #64748B，外套 32×32 #f8fafc 圆角 8）；Email/Role/Status 三段；Status 为 382 宽分段单选；底部 Cancel + Create/Save；邮件投递结果如实回显 |
| 支付网关 / 通知配置 | 复用子导航 + 卡片规范 |
| 忘记 / 重置密码、激活 | 复用登录页认证外壳 |

## Figma 图标导出

画板内的矢量图标通过 Figma REST API 导出为 SVG，保存在 `docs/design/figma/icons-*.svg`，
对应关系：

| 文件 | Figma 节点 |
|---|---|
| `icons-course.svg` | `book-line` |
| `icons-knowledge.svg` | `stack-line` |
| `icons-aiTutor.svg` | `loader-fill` |
| `icons-order.svg` | `booklet-line` |
| `icons-reporting.svg` | `dashboard-2-line` |
| `icons-student.svg` | `user-settings-line` |
| `icons-helpDesk.svg` | `book-read-line` |
| `icons-settings.svg` | `settings-2-line` |
| `icons-toggle.svg` | `Collapse Sidebar / Left` |
| `icons-close.svg` / `icons-xcircle.svg` | 弹窗 `close-button` |
| `icons-brandIcon.svg` | 顶栏 `Frame 41 / Icon` |
| `icons-mail.svg` / `icons-lock.svg` / `icons-eye.svg` | 登录页输入框图标 |

实现侧矢量的 path 数据直接复制自这些导出文件（`backoffice/components/icons.tsx`），
颜色统一走 `currentColor`，激活态由 CSS 决定（#145cff）。

实现截图放在 `docs/design/figma/impl/`，可与 `docs/design/figma/1-*.png` 直接叠看。
