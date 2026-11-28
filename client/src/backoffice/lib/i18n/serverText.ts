import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";
import { t } from "./messages";

/**
 * 后端错误是写死的单语言句子（大多中文，少数英文），会被各模块直接显示。
 * 所有请求出口都经过这里，保证用户读到的错误是当前页面的语言：
 *   1. 句子已经是当前语言 → 原样显示；
 *   2. 下表有对应译文 → 显示译文；
 *   3. 否则显示通用提示，原文只进控制台。绝不把另一种语言的句子显示给用户。
 * 新增后端中文报错时要在这里加译文，tests/i18n-guard.test.ts 会扫描后端源码检查。
 */
export const SERVER_MESSAGES: ReadonlyArray<readonly [zh: string, en: string]> = [
  ["版本不存在","The release does not exist."],
  ["目标课程不存在","The target course does not exist."],
  ["目标课程的外部课程标识与源课程不一致","The source and target courses have different external identifiers."],
  ["目标课程绑定的商品课程编号与源课程不一致","The source and target courses are linked to different commerce course codes."],
  ["版本内容 ID 与其他课程冲突","A package identifier belongs to another course."],
  ["目标课程绑定已改变","The target course binding has changed."],
  ["请选择知识版本 ZIP","Choose a knowledge release ZIP."],
  ["版本包缺少有效的对象","A package object is missing or invalid."],
  ["版本包缺少有效的列表","A package list is missing or invalid."],
  ["版本包文本字段无效","A package text field is invalid."],
  ["版本包标识无效","A package identifier is invalid."],
  ["版本包整数无效","A package integer is invalid."],
  ["版本包日期无效","A package date is invalid."],
  ["此版本缺少可迁移的编辑快照","This release has no transferable editor snapshot."],
  ["页面同步状态无效","A page has an invalid sync state."],
  ["编辑快照与该版本的教学包输入不一致","The editor snapshot does not match the release's teaching package input."],
  ["请选择有效的知识版本 ZIP","Choose a valid knowledge release ZIP."],
  ["版本包文件路径无效","The version package contains an invalid path."],
  ["缺少版本包清单。请选择可迁移版本 ZIP。","The package manifest is missing. Choose a migration ZIP."],
  ["版本包清单摘要不一致","The package manifest checksum does not match."],
  ["不支持的版本包格式","Unsupported release package format."],
  ["版本包包含未登记文件","The package contains an unlisted file."],
  ["知识版本 ZIP 无效或已损坏","The knowledge release ZIP is invalid or corrupt."],
  ["发布页面与编辑快照不一致","Published pages differ from the editor snapshot."],
  ["此版本缺少教学包原始输入","This release is missing its original teaching package input."],
  ["存在未引用的图片","The package contains an unused image."],
  ["版本包包含重复的页面","The release package has duplicate page identifiers."],
  ["版本包包含重复的条目","The release package has duplicate entry identifiers."],
  ["版本包包含重复的课节绑定","The release package has duplicate lesson bindings."],
  ["缺少 embedding 配置", "Embedding is not configured."],
  ["向量检索上游暂不可用", "The embedding retrieval service is temporarily unavailable."],
  ["模型不在可用列表中", "The selected model is not available."],
  ["测试版本已变化，请刷新后重试", "The test release has changed. Refresh and try again."],
  ["课程在你打开后已被他人修改，请刷新后查看最新内容。", "This course was changed by someone else after you opened it. Refresh to see the changes."],
  ["上线版本已变化，请刷新后重试", "The live release has changed. Refresh and try again."],
  ["Yong 方案不可用", "The Yong running solution is unavailable."],
  ["LLM 上游生成失败", "The model could not complete this response."],
  ["LLM 上游连接中断", "The model connection was interrupted."],
  ["所选知识库版本没有可用正文", "The selected release has no usable course content."],
  ["所选知识库版本缺少索引，请在版本列表中重建索引后再测试", "The selected knowledge release has no search index. Rebuild it from the release list before testing."],
  ["任务名称须为 1–80 个字符，且不能包含控制字符", "Use a task name of 1–80 characters without control characters."],
  ["向量检索无法连接", "The knowledge search service could not be reached."],
  ["所选知识库版本不存在", "The selected release does not exist."],
  ["知识库版本不属于当前课程", "The release does not belong to this course."],
  ["AI 回答连接中断，请重试", "AI response was interrupted"],
  ["AI 回答未完成，请重试", "AI response was not completed"],
  ["AI 响应格式错误，请重试", "Invalid AI stream event"],
  ["服务器内部错误", "Internal server error."],
  ["课程存储不可用，请联系运维检查课程存储桶与实例角色权限", "Course storage is unavailable. Ask operations to check the course storage bucket and instance role permissions."],
  ["文件大小超过 15MB 限制", "The file is larger than the 15 MB limit."],
  ["请求内容过大，请拆分文档后重试", "The request is too large. Split the document and try again."],
  ["数据校验失败", "The data could not be validated."],
  ["数据已存在（唯一约束冲突）", "This record already exists."],
  ["请求的资源不存在", "The requested item does not exist."],
  ["关联记录不存在，违反外键约束", "A linked record does not exist."],
  ["字段值超出允许长度", "A value is longer than allowed."],
  ["未授权访问", "You are not authorised."],
  ["课程不存在", "The course does not exist."],
  ["所属课程不存在", "The course this belongs to does not exist."],
  ["该课程 AI 导师未开放", "AI Tutor is not available for this course."],
  ["该课程尚未发布可用版本", "This course has no published version yet."],
  ["该课程没有可用的测试或上线版本", "This course has no test or live version."],
  ["AI 回答达到输出上限，内容未完成", "The AI answer reached its length limit and is incomplete."],
  ["发布版本不存在或不属于该课程", "The release does not exist or does not belong to this course."],
  ["发布版本不存在", "The release does not exist."],
  ["该版本为上线版本（Live），不可删除", "This is the live version and cannot be deleted."],
  ["releaseId 为必填项", "releaseId is required."],
  ["revisionNotes 为必填项", "Revision notes are required."],
  ["apiKey 密文格式非法", "The stored API key is not valid."],
  ["未选择文件（multipart 字段名须为 file）", "No file was selected."],
  ["未选择图片", "No image was selected."],
  ["图片不存在", "The image does not exist."],
  ["图片不能超过 20 MiB", "The image cannot exceed 20 MiB."],
  ["图片的像素数或动画帧数超过限制", "The image exceeds the pixel or animation frame limit."],
  ["仅支持未压缩的 24 位或 32 位 BMP/DIB 图片", "Only uncompressed 24-bit and 32-bit BMP/DIB images are supported."],
  ["图片处理繁忙，请稍后重试", "Image processing is busy. Try again shortly."],
  ["不支持此图片格式", "This image format is unsupported."],
  ["无法解码 HEIC、HEIF 或 AVIF 图片，请尝试导出为 JPEG 或 PNG", "This HEIC, HEIF or AVIF image could not be decoded. Try exporting it as JPEG or PNG."],
  ["图片已损坏或格式不受支持", "The image is damaged or its format is unsupported."],
  ["图片不能超过 5MB", "The image cannot be larger than 5 MB."],
  ["仅支持 PNG、JPEG、GIF、WebP 图片", "Only PNG, JPEG, GIF and WebP images are supported."],
  ["文档转换结果为空", "The document converted to nothing."],
  ["DOCX 文件包含过多内容", "The DOCX file has too much content."],
  ["DOCX 解压内容超过安全限制", "The unpacked DOCX is larger than the safety limit."],
  ["页面不存在", "The page does not exist."],
  ["排序列表必须为该课程全部页面的完整排列", "The order must list every page of this course."],
  ["页面创建请求已被使用", "This page creation request has already been used."],
  ["课程页面已变化，请重新确认后再清除", "The course pages have changed. Review and confirm again before clearing them."],
  ["本期仅同步课程与课时标题，正文内容同步已禁用", "Only course and lesson titles are synced for now. Content sync is off."],
  ["该课程不在同步映射表中", "This course is not in the sync mapping."],
  ["标签名称不能为空", "The tag name cannot be empty."],
  ["原始素材 ZIP 中找不到 Excel（.xlsx）模板文件", "The ZIP has no Excel (.xlsx) template."],
  ["Lessons 工作表没有可导入的课时", "The Lessons sheet has no lessons to import."],
  ["Lessons Sheet 中没有可导入的课时", "The Lessons sheet has no lessons to import."],
  ["操作成功", "Done."],
  ["AI 服务返回空回答，请重试或检查模型配置", "The AI service returned an empty answer. Try again or check the model settings."],
  ["该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本", "This course has no knowledge release yet. Create one on the Releases tab in Knowledge."],
  ["没有检索到当前课程版本的知识证据，请改为课程范围内的问题", "No knowledge was found for this course version. Ask a question within the course."],
  ["课程知识证据超出当前上下文预算，未调用 AI Tutor", "The course knowledge is over the context budget, so AI Tutor was not called."],
  ["未配置可用的 LLM API Key（课程级未设置且 OPENROUTER_API_KEY 缺失）", "No LLM API key is configured for this course or the system."],
  ["该课程尚未发布知识库版本，无法保存或重置 AI 配置（请先创建 Release）", "This course has no knowledge release yet, so its AI settings cannot be saved or reset. Create a release first."],
  ["AI_CONFIG_ENCRYPTION_KEY 未配置或格式错误（需 64 位 hex）", "The AI settings encryption key is missing or invalid."],
  ["响应无法解析", "The response could not be read."],
  ["该课程已存在发布历史版本，拒绝删除；如需删除请先处理历史版本", "This course has released versions and cannot be deleted. Deal with those versions first."],
  ["文件内容不是有效的 .xls 格式（请确认文件类型）", "The file is not a valid .xls file."],
  ["文档转换失败，请检查文件是否损坏或受密码保护", "The document could not be converted. Check that it is not damaged or password protected."],
  ["LaTeX 文件必须为有效的 UTF-8 文本", "The LaTeX file must be valid UTF-8 text."],
  ["DOCX 含图片，请从 Knowledge Pages 课程中导入", "This DOCX contains images. Import it from a course in Knowledge Pages."],
  ["该版本为 AI Tutor 后台测试所选版本，不可删除", "This version is selected for AI Tutor testing and cannot be deleted."],
  ["热门课程只能选择 1–6 门。", "Popular Courses allows 1–6 courses."],
  ["工作区版本已变化，请重新加载后编辑", "The workspace has changed. Reload before editing."],
  ["无法恢复此格式的编辑快照", "This editor snapshot format cannot be restored."],
  ["旧版本缺少教学条目编辑快照，无法恢复含教学条目的工作区。可继续预览或设为 Live。", "This older version has no editable teaching entry snapshot. You can still preview it or set it live."],
];

const TEACHING_ERRORS: Readonly<Record<string, readonly [string, string]>> = {
  TEACHING_REFERENCE_DOCUMENT_INVALID: ["无法读取引用文档，请检查标题和内容。", "The reference document could not be read. Check its headings and content."],
  TEACHING_REFERENCE_WRONG_KIND: ["文件与所选引用类型不符。", "The file does not match the selected reference type."],
  TEACHING_TRANSFER_SELECTION: ["选中的条目已变化，请刷新后重新选择。", "The selected entries have changed. Refresh and select them again."],
  TEACHING_TRANSFER_UNPORTABLE: ["条目缺少可下载的资源或稳定的引用编号，请检查其引用。", "An entry is missing a downloadable resource or a stable reference code. Check its references."],
  TEACHING_TRANSFER_TOO_LARGE: ["导出文件的大小或条目数超限。请减少所选条目后重试。", "The export exceeds the file size or entry limit. Select fewer entries and try again."],
  TEACHING_REFERENCE_BATCH_LIMIT: ["本批引用条目数量超限，请分批确认导入。", "This batch exceeds the reference limit. Import it in smaller batches."],
  TEACHING_SHEET_INVALID: ["表格无法读取或格式不符。请使用对应模板，检查表头、文本单元格和文件大小。", "The workbook could not be read or does not match the template. Check the headers, text cells and file size."],
  TEACHING_SHEET_CHANGED: ["条目、原文或引用已变化，请刷新预览后再导入。", "An entry, source passage or reference has changed. Refresh the preview and try again."],
  DEFINITION_PASSAGE_CHANGED: ['关联原文已变化或不唯一，请重新选择。', 'The linked passage changed or is ambiguous. Select it again.'],
  REFERENCE_CODE_IN_USE: ['本课程已使用这个编号（含历史编号），请换一个。', 'This course already uses that number or alias. Choose another.'],
  REFERENCE_SUMMARY_REQUIRED: ['请填写摘要。', 'Enter a summary.'],
  SCHEMA_NOT_READY: ['数据库版本未就绪，请管理员检查部署迁移。', 'The database schema is not ready. Ask an administrator to check the deployment migrations.'],
  LECTURE_REFERENCE_CATALOG_INVALID: ['本课程的引用对象有冲突或格式有误，请检查已保存的条目。', 'References for this course contain a conflict or an invalid entry. Check the saved teaching entries.'],
  INVALID_TEACHING_CARD: ['教学条目信息不完整或格式有误。', 'Complete the required teaching entry fields and check their format.'],
  TEACHING_CARD_NOT_FOUND: ['找不到这条教学条目。', 'This teaching entry could not be found.'],
  TEACHING_CARD_REVISION_CHANGED: ['条目已被更新。请刷新并核对最新版本后重试。', 'This entry has changed. Refresh and review the latest version before trying again.'],
}

/** 带变量的后端句子：同样两种语言都写，正则从中文原文取变量。 */
export const SERVER_MESSAGE_PATTERNS: ReadonlyArray<readonly [zh: RegExp, en: (m: RegExpMatchArray) => string]> = [
  [/^图片引用「(.+)」超过单图 8 MiB 限制$/, (m) => `Image reference "${m[1]}" exceeds the 8 MiB limit for a single image.`],
  [/^DOCX 包含暂不支持的 Word 公式结构（(.+)）$/, (m) => `The DOCX contains an unsupported equation structure (${m[1]}).`],
  [/^DOCX 公式导入不完整（(.+)），请检查原文$/, (m) => `The DOCX import read ${m[1]} equations. Check the source document.`],
  [/^页面「(.+)」的图片无法导出：(.+)$/, (m) => `The image in "${m[1]}" cannot be exported: ${m[2]}`],
  [/^页面「(.+)」的图片不存在：(.+)$/, (m) => `The image in "${m[1]}" is missing: ${m[2]}`],
  [/^页面「(.+)」的课程引用不可用：(.+)$/, (m) => `Course reference ${m[2]} is unavailable in "${m[1]}".`],
  [/^不支持的 LLM 模型：(.+)$/, (m) => `Unsupported LLM model: ${m[1]}`],
  [/^不支持的 LLM Provider: (.+)$/, (m) => `Unsupported LLM provider: ${m[1]}`],
  [/^Tag "(.+)" 不存在$/, (m) => `The tag "${m[1]}" does not exist.`],
  [/^知识库服务暂不可用（(.+)）$/, () => "The knowledge service is unavailable right now."],
  [/^向量检索请求超时，阶段 (.+)$/, () => "The knowledge search request timed out."],
  [/^(?:版本图片不存在|版本引用的图片缺失|缺少或无效的图片)：(.+)$/, m => "Missing or invalid course image: " + m[1]],
  [/^(?:图片格式与文件名不符|课程图片文件名无效|图片摘要不一致)：(.+)$/, m => "Course image validation failed: " + m[1]],
  [/^版本中存在跨课程图片：(.+)$/, m => "Image belongs to a different course: " + m[1]],
  [/^定义的来源页不存在：(.+)$/, m => "The definition refers to a missing page: " + m[1]],
  [/^页面「(.+)」引用不存在：(.+)$/, m => "Unresolved course reference: " + m[2]],
  [/^版本校验失败：(.+)$/, m => translate(m[1], "en-GB") ?? "The teaching package could not be validated."],
  [/^教学包校验失败：(.+)$/, (m) => `The teaching package could not be validated: ${m[1]}`],
  [/^Excel 模板结构无法识别：(.+)$/, () => "The Excel template could not be read: expected the Course info and Lessons sheets."],
  [/^Excel 缺少 Sheet：(.+)$/, (m) => `The Excel file is missing sheets: ${m[1]}`],
  [/^LLM 上游返回 (.+)$/, (m) => `The LLM service answered ${m[1]}`],
  [/^请求过于频繁，请稍后再试（每课程每分钟最多 (.+) 次）$/, (m) => `Too many requests. Try again shortly (at most ${m[1]} per course per minute).`],
  [/^格式暂不支持：(.+)（支持 (.+)）$/, (m) => `This format is not supported: ${m[1].replace("未知", "unknown")} (supported: ${m[2]}).`],
  [/^(.+)不存在$/, (m) => `${m[1]} does not exist.`],
];

const HAN = /\p{Script=Han}/u;

/** 非 React 代码（请求层、错误边界）取当前语言的唯一来源：地址栏第一段。 */
export function currentLocale(): Locale {
  const segment = typeof window === "undefined" ? undefined : window.location.pathname.split("/")[1];
  return isLocale(segment) ? segment : DEFAULT_LOCALE;
}

export function serverText(raw: string | null | undefined, locale: Locale = currentLocale()): string {
  const text = (raw ?? "").trim();
  const translated = text ? translate(text, locale) : null;
  if (translated) return translated;
  if (text) console.warn("[i18n] 后端文本没有当前语言的译文:", text);
  return t(locale, "errors.serverGeneric");
}

function translate(text: string, locale: Locale): string | null {
  if (Object.hasOwn(TEACHING_ERRORS, text))
    return TEACHING_ERRORS[text][locale === 'zh-CN' ? 0 : 1];
  const isZh = HAN.test(text);
  if (locale === "zh-CN") {
    if (isZh) return text;
    return SERVER_MESSAGES.find(([, en]) => en === text)?.[0] ?? null;
  }
  if (!isZh) return text;
  const exact = SERVER_MESSAGES.find(([zh]) => zh === text);
  if (exact) return exact[1];
  for (const [pattern, en] of SERVER_MESSAGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const out = en(match);
      return HAN.test(out) ? null : out;
    }
  }
  return null;
}
