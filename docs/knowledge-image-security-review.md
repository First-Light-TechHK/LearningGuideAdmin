# Knowledge 图片与 DOCX 导入审查

审查范围：Knowledge Pages 图片上传/读取、DOCX 内嵌图片提取、图片自动清理及其权限路由。此审查只检查当前实现，没有修改代码，也没有运行攻击性测试。

## 结论

当前实现对普通图片做了文件大小限制、文件签名检查和登录权限控制，但仍有一个需要优先处理的资源耗尽风险，以及一个会造成已发布内容图片失效的清理逻辑缺陷。另有清理查询的扩展性问题。

## 高优先级

### KI-001：DOCX 解压没有解压后大小限制

- 严重性：High
- 位置：[files.controller.ts:25](../server/src/files/files.controller.ts:25)、[files.service.ts:267](../server/src/files/files.service.ts:267)、[files.service.ts:299](../server/src/files/files.service.ts:299)
- 证据：上传限制仅约束压缩后的文件大小；随后 `JSZip.loadAsync(docx)` 加载归档，并对每个图片条目调用 `async('nodebuffer')`，未检查单项或解压后总字节数。
- 影响：有上传权限的员工可提交高压缩比 DOCX，触发大量内存分配，造成后端内存耗尽或服务不可用。
- 建议：提取前检查 ZIP 中图片条目的声明大小和总量；设置图片数量、单图大小、解压总量上限，并在处理过程中累计实际解压字节数，超限立即中止。仅检查压缩包上传大小不足以限制 ZIP bomb。

## 中优先级

### KI-002：清理只检查当前页面，可能删除已发布快照仍使用的图片

- 严重性：Medium
- 位置：[files.service.ts:122](../server/src/files/files.service.ts:122)、[files.service.ts:127](../server/src/files/files.service.ts:127)、[schema.prisma:99](../server/prisma/schema.prisma:99)
- 证据：清理逻辑只查 `Page.contentMd`；Release 的 `snapshotData` 也会保存页面 `contentMd`（见 [releases.service.ts:97](../server/src/releases/releases.service.ts:97)）。
- 影响：图片被当前页面移除后，超过 24 小时清理器可能删除它，但已发布 Release 的快照仍引用该图片，导致学员或历史版本看到缺图。
- 建议：垃圾回收的引用检查同时覆盖所有仍可访问的 Release 快照；或者在发布时建立图片引用记录，并在 Release 过期/删除时释放引用。

### KI-003：清理任务按图片逐个读取课程全部页面

- 严重性：Medium（工程容量风险）
- 位置：[files.service.ts:119](../server/src/files/files.service.ts:119)、[files.service.ts:122](../server/src/files/files.service.ts:122)
- 证据：每个过期图片都会再次查询该课程所有页面的完整 Markdown。
- 影响：数据库读取量随“过期图片数 × 课程页面数”增长；页面内容较大时，启动清理和每小时扫描会产生明显负载。
- 建议：按课程批量取一次页面和 Release 引用，构造该课程的引用集合；为扫描加分页/批次上限，并记录每轮清理数量和耗时。

## 已检查且当前看起来合理的部分

- 图片上传限制为 5 MB，并根据 PNG/JPEG/GIF/WebP 文件签名判断格式，而非信任客户端 MIME（[files.service.ts:70](../server/src/files/files.service.ts:70)）。
- 图片 URL 使用随机 UUID；对象存储键基于服务端生成的课程 ID、UUID 和识别出的扩展名。
- DOCX 关系目标只用于查 ZIP 内条目，没有把不可信目标交给文件系统读取；外部关系不会触发服务端网络请求。
- 路由由全局 BackOffice 权限守卫处理；图片上传要求 `EDIT_EXISTING`，图片读取按 GET 要求 `VIEW`。这与 Knowledge 页面的菜单访问模型一致。
- 当前图片格式不允许 SVG，降低了上传可执行 SVG 并以内联方式呈现的风险。

## 限制

本审查没有验证生产反向代理的请求体总量限制、Nest/Express 全局速率限制或对象存储生命周期配置；这些部署层控制需在运行环境另行确认。
