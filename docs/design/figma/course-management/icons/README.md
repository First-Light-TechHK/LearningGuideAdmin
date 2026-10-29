# Course Management · 矢量图标

来源 Figma 「course management」文件（fileKey `Z6GJpeiHIsRJYVPQvfsgTz`）/ 画布 `Page 1`（`0:1`），
与 `docs/design/figma/course-management/` 下的画板 PNG 一一对应。

## 生成方式

图标几何**原样取自设计稿**：通过 Figma REST API
`GET /v1/files/:key/nodes?ids=0:1&geometry=paths` 拉取整页节点树（含 `fillGeometry` / `strokeGeometry` 路径），
再把每个图标容器（≤72px、无文字、含矢量）的可见矢量节点按其颜色与相对位移重建为独立 SVG。
因此路径与设计稿逐字节一致，缩放不失真。

- 同形状不同配色的图标按「几何签名」去重，保留一份并记录全部 `nodeId`（见 `manifest.json`）。
- 单一中性色（黑/灰）的图标使用 `currentColor`，可直接继承文字色（`themeable: true`）。
- 品牌色（蓝 `#1d6bff`）或含多色的图标保留硬编码颜色（`themeable: false`）。

## 目录内容

| 文件 | 说明 |
|---|---|
| `*.svg` | 100 个图标，命名见下表 |
| `manifest.json` | 每个图标的尺寸、Figma 节点、颜色、是否可着色、出现于哪些画板 |
| `preview.html` | 浏览器打开即可总览全部图标（网格预览） |
| `_overview.png` | 全部图标拼图（10 列），供 README / 快速核对 |

## 使用约定（后续 Course 功能页实现）

- 图标严格参照设计稿，不要用近似的第三方图标替代。
- `themeable: true` 的图标以 `currentColor` 输出，用 `color` 控制颜色即可（如侧栏激活 `#1d6bff`、未激活 `#111827`）。
- 内置品牌 logo、视频封面图标等含多色的保留原色，直接内联使用。
- 尺寸以 `width` / `height` / `viewBox` 为准，按设计稿原始网格（12/14/16/18/20/24/34/36/40/42/44/48）渲染。

## 图标清单

### 侧栏 / 顶栏导航（20px 网格）

| 名称 | 说明 |
|---|---|
| `nav-ref-course` / `nav-ref-knowledge` / `nav-ref-ai-tutor` / `nav-ref-order` / `nav-ref-reporting` / `nav-ref-student` / `nav-ref-helpdesk` / `nav-ref-settings` | 菜单图标（黑，未激活态） |
| `nav-course-active` / `nav-knowledge` / `nav-ai-tutor` / `nav-order` / `nav-reporting` / `nav-student` / `nav-helpdesk` / `nav-settings` | 侧栏菜单图标（含当前页激活蓝色态） |
| `topbar-logo` / `topbar-logo-cap` / `topbar-collapse` | 顶栏品牌 logo、学士帽、折叠按钮 |
| `brand-logo` / `brand-cap` | 品牌标识（42×42 圆角 + 学士帽） |
| `sidebar-collapse` / `sidebar-collapse-glyph` | 侧栏折叠按钮及内部箭头 |
| `notification-bell` | 通知铃铛 |

### 通用控件

| 名称 | 说明 |
|---|---|
| `chevron-down` / `chevron-down-sm` / `chevron-down-xs` / `chevron-left` / `chevron-up` | 下拉 / 分页 / 折叠箭头 |
| `more-vertical` | 行内「⋮」操作菜单（蓝色） |
| `close` / `close-circle-lg` | 关闭（弹窗 / 预览浮层） |
| `search` | 搜索 |
| `plus` | 新增 |
| `remove-circle` | 删除（灰） |
| `checkbox-checked` / `checkbox-check` | 勾选框 |
| `toggle-on` | 开关（ON） |
| `check-step` / `check-circle-green` / `text-ok` | 完成 / 通过状态 |
| `rating-stars` | 星级（含 on/off 复合态） |
| `alert-circle` / `alert-circle-red` / `alert-triangle` / `alert-triangle-sm` / `video-error` | 警告 / 错误 |
| `info-circle` / `info-sm` / `course-settings-info` | 信息提示 |
| `eye` | 预览（以学员身份） |
| `drag-grip` / `provides-drag-grip` / `provides-drag-grip-sm` | 拖拽手柄 |
| `chip-icon` / `lesson-id-icon` | 标签 / 课程编号前缀 |
| `upload-cloud` / `upload-cloud-2` | 上传 |

### Course 业务图标

| 名称 | 说明 |
|---|---|
| `provides-badge-target` / `provides-target` | This course provides · 目标受众 |
| `provides-badge-download` / `provides-download` | 下载 |
| `provides-badge-device` / `provides-device` | 设备 / 终端 |
| `provides-badge-certificate` / `provides-certificate` | 证书 |
| `preset-1..4` / `preset-1..4-badge` / `preset-error` / `preset-error-badge` | 预设项徽标 |
| `star-badge-on` / `star-on` / `star-badge-off` / `star-off` | 评分 / 收藏 |
| `import-chevron` / `import-chevron-sm` / `import-docx-chevron` | 导入菜单箭头 |
| `media-1..4` / `media-1-active` / `media-2-active` | 富文本媒体菜单 |
| `exhibit-card-icon` / `exhibit-file` / `exhibit-thumb` | 展品卡片 |
| `item-badge` / `item-badge-selected` / `item-icon` / `item-icon-selected` | 课程条目图标 |
| `video-thumb` / `video-thumb-play` / `play-white` / `play-white-sm` | 视频缩略 / 播放 |
