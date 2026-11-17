import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ReadingType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  allocate,
  exhibitCounterKey,
  formatApplicationCode,
  formatExhibitCode,
  formatKnowledgeCode,
  lessonNumber,
} from './code-allocator';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { parseLanguage } from './course-info';
import { runCourseWrite, type CourseTx } from './course-write';
import {
  parseTriggers,
  parseVideoPoints,
  saveTriggersInTx,
  saveVideoPointsInTx,
} from './study-points';
import { defaultLanguageTest } from './lesson-tests';
import { convertDocxToHtml } from './docx-to-html';
import { exhibitInUseMessage, textUsages, videoUsages } from './exhibit-usage';
import { requireArray } from './input';
import {
  checkReadingRows,
  missingReadingColumns,
  parseReadingList,
  readingTemplateCsv,
} from './reading-import';
import {
  normalizeHeader,
  readSheetTable,
  sheetCell,
  type SheetTable,
} from './sheet-table';
import { mp4DurationSeconds } from './media-duration';
import {
  MediaValidationError,
  validateMediaFile,
  type MediaKind,
  type ValidatedMedia,
} from './media-validate';
import { CourseStorageService } from './storage.service';
import { categoryRef, EXHIBIT_FIELDS } from './localized-fields';
import { parseLocalized } from '../common/i18n/localized';

/** 读取可以走事务外的连接，也可以走写入事务里的连接。 */
type Db = PrismaService | CourseTx;

/** 推荐阅读只有一份英文列表（PRD L411）。 */
const READING_LANGUAGE = 'en-GB';
const EXHIBIT_TYPES = new Set(['IMAGE', 'VIDEO', 'MODEL3D']);

function required(value: unknown, message: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BadRequestException({ code: 'REQUIRED', message });
  return text;
}

function upper(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

@Injectable()
export class CourseAuthoringService {
  private readonly videoDurationCache = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  async listCategories() {
    const rows = await this.prisma.courseCatalogueEntry.findMany({
      where: { parentId: null, status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, localized: true },
    });
    return rows.map((row) => categoryRef(row));
  }

  async uploadMedia(
    courseId: string,
    file:
      { originalname: string; mimetype?: string; buffer: Buffer } | undefined,
    expected?: 'COVER' | 'VIDEO' | 'IMAGE',
  ) {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'No file uploaded.',
      });
    }
    await this.assertCourse(courseId);
    let validated: ValidatedMedia;
    try {
      validated = validateMediaFile(
        {
          name: file.originalname,
          type: file.mimetype,
          bytes: file.buffer,
        },
        this.config,
      );
    } catch (error) {
      if (error instanceof MediaValidationError) {
        throw new BadRequestException({
          code: 'MEDIA_INVALID',
          message: error.message,
        });
      }
      throw error;
    }
    this.assertExpectedKind(validated.kind, expected);

    const assetId = randomUUID();
    const storageKey = this.storage.mediaKey(
      courseId,
      assetId,
      validated.extension,
    );
    await this.storage.putMedia(storageKey, file.buffer);
    try {
      const asset = await this.prisma.courseMediaAsset.create({
        data: {
          id: assetId,
          courseId,
          kind: validated.kind as never,
          originalName: validated.originalName,
          mimeType: validated.mimeType,
          extension: validated.extension,
          size: validated.size,
          storageKey,
          checksum: CourseStorageService.sha256(file.buffer),
        },
        select: {
          id: true,
          kind: true,
          originalName: true,
          mimeType: true,
          extension: true,
          size: true,
        },
      });
      // 时长解析需要整份文件：刚上传时 Buffer 就在手上，顺手算好并缓存，
      // 绑定到课时（setLessonVideo）时就不必再从存储下载一遍几百 MB 的视频。
      let durationSeconds: number | null = null;
      if (
        validated.kind === 'VIDEO' &&
        ['mp4', 'mov'].includes(validated.extension)
      ) {
        durationSeconds =
          Math.max(0, Math.round(mp4DurationSeconds(file.buffer) ?? 0)) || null;
        this.rememberVideoDuration(asset.id, durationSeconds);
      }
      return { ...asset, durationSeconds };
    } catch (error) {
      await this.storage.removeMedia(storageKey).catch(() => undefined);
      throw error;
    }
  }

  /** 视频时长小缓存（进程内，最多保留 200 条），避免绑定课时时重复下载大文件。 */
  private rememberVideoDuration(assetId: string, seconds: number | null): void {
    if (seconds === null) return;
    this.videoDurationCache.delete(assetId);
    this.videoDurationCache.set(assetId, seconds);
    while (this.videoDurationCache.size > 200) {
      const oldest = this.videoDurationCache.keys().next().value;
      if (oldest === undefined) break;
      this.videoDurationCache.delete(oldest);
    }
  }

  async uploadCover(
    courseId: string,
    file:
      { originalname: string; mimetype?: string; buffer: Buffer } | undefined,
  ) {
    const asset = await this.uploadMedia(courseId, file, 'COVER');
    try {
      await runCourseWrite(this.prisma, courseId, async (tx) => {
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: { coverAssetId: asset.id },
        });
      });
    } catch (error) {
      // 封面没绑上：刚传的文件和资产行不留下孤儿。
      await this.discardUploadedAsset(courseId, asset);
      throw error;
    }
    return asset;
  }

  private async discardUploadedAsset(
    courseId: string,
    asset: { id: string; extension: string },
  ): Promise<void> {
    await this.prisma.courseMediaAsset
      .delete({ where: { id: asset.id } })
      .catch(() => undefined);
    await this.storage
      .removeMedia(this.storage.mediaKey(courseId, asset.id, asset.extension))
      .catch(() => undefined);
  }

  async deleteCover(courseId: string) {
    await runCourseWrite(this.prisma, courseId, async (tx) => {
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: { coverAssetId: null },
      });
    });
    return { deleted: true };
  }

  async setLessonVideo(
    courseId: string,
    lessonId: string,
    language: string,
    assetId: string,
  ) {
    // 下载、解析时长都放在事务外：事务里只做写入，不拿着课程锁等存储。
    await this.requireLesson(courseId, lessonId);
    const asset = await this.requireAsset(courseId, assetId);
    if (asset.kind !== 'VIDEO') {
      throw new BadRequestException({
        code: 'VIDEO_REQUIRED',
        message: 'Choose a video asset.',
      });
    }
    const cachedDuration = this.videoDurationCache.get(assetId);
    const duration =
      cachedDuration ??
      (asset.extension.toLowerCase() === 'mp4'
        ? Math.max(
            0,
            Math.round(
              mp4DurationSeconds(
                await this.storage.getMedia(asset.storageKey),
              ) ?? 0,
            ),
          ) || null
        : null);
    await runCourseWrite(this.prisma, courseId, async (tx) => {
      const lesson = await this.requireLesson(courseId, lessonId, tx);
      const existing = lesson.localizations.find(
        (loc) => loc.language === language,
      );
      await tx.lessonLocalization.upsert({
        where: { lessonId_language: { lessonId, language } },
        create: {
          lessonId,
          language,
          title: existing?.title ?? lesson.code,
          description: existing?.description ?? null,
          videoAssetId: assetId,
          videoDurationSeconds: duration,
          textHtml: existing?.textHtml ?? null,
        },
        update: { videoAssetId: assetId, videoDurationSeconds: duration },
      });
    });
    return { assetId, durationSeconds: duration };
  }

  async saveVideoLearningPoints(
    courseId: string,
    lessonId: string,
    language: string,
    input: unknown,
  ) {
    const lang = parseLanguage(language, 'language');
    const rows = parseVideoPoints(input);
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      await this.requireLesson(courseId, lessonId, tx);
      return { points: await saveVideoPointsInTx(tx, lessonId, lang, rows) };
    });
  }

  async saveTriggers(
    courseId: string,
    lessonId: string,
    language: string,
    input: unknown,
  ) {
    const lang = parseLanguage(language, 'language');
    const rows = parseTriggers(input);
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      const lesson = await this.requireLesson(courseId, lessonId, tx);
      const exhibitIds = new Set(lesson.exhibits.map((exhibit) => exhibit.id));
      return saveTriggersInTx(tx, lessonId, lang, rows, exhibitIds);
    });
  }

  /**
   * 新展品：编号由服务器按课程分配（E001、E002……，全课程唯一，删除后不再发），
   * 发来的 `code` 不算数；排在本课时展品的最后。
   */
  async createExhibit(
    courseId: string,
    lessonId: string,
    body: {
      /** 已忽略：展品编号由服务器分配。 */
      code?: string;
      type: string;
      mediaAssetId?: string | null;
      thumbnailAssetId?: string | null;
      sourceText?: string | null;
      localized?: unknown;
    },
  ) {
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      await this.requireLesson(courseId, lessonId, tx);
      const type = upper(body.type);
      if (!EXHIBIT_TYPES.has(type)) {
        throw new BadRequestException({
          code: 'EXHIBIT_TYPE_INVALID',
          message: 'Media type must be Image, Video or 3D.',
        });
      }
      if (body.mediaAssetId) {
        await this.requireAsset(courseId, body.mediaAssetId, tx);
      }
      if (body.thumbnailAssetId) {
        await this.requireAsset(courseId, body.thumbnailAssetId, tx);
      }
      const code = await this.allocateExhibitCode(courseId, tx);
      return tx.exhibit.create({
        data: {
          lessonId,
          courseId,
          sortOrder: await this.nextExhibitOrder(lessonId, tx),
          code,
          type: type as never,
          mediaAssetId: body.mediaAssetId ?? null,
          thumbnailAssetId: body.thumbnailAssetId ?? null,
          sourceText: body.sourceText ?? null,
          localized: parseLocalized(body.localized, EXHIBIT_FIELDS),
        },
      });
    });
  }

  async updateExhibit(
    courseId: string,
    lessonId: string,
    exhibitId: string,
    body: {
      type?: string;
      mediaAssetId?: string | null;
      thumbnailAssetId?: string | null;
      sourceText?: string | null;
      localized?: unknown;
    },
  ) {
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      await this.requireLesson(courseId, lessonId, tx);
      const exhibit = await tx.exhibit.findFirst({
        where: { id: exhibitId, lessonId },
      });
      if (!exhibit)
        throw new NotFoundException({
          code: 'EXHIBIT_NOT_FOUND',
          message: 'Exhibit not found.',
        });
      if (body.mediaAssetId) {
        await this.requireAsset(courseId, body.mediaAssetId, tx);
      }
      if (body.thumbnailAssetId) {
        await this.requireAsset(courseId, body.thumbnailAssetId, tx);
      }
      const type = body.type ? upper(body.type) : null;
      if (type && !EXHIBIT_TYPES.has(type)) {
        throw new BadRequestException({
          code: 'EXHIBIT_TYPE_INVALID',
          message: 'Media type must be Image, Video or 3D.',
        });
      }
      return tx.exhibit.update({
        where: { id: exhibitId },
        data: {
          ...(type ? { type: type as never } : {}),
          ...(body.mediaAssetId !== undefined
            ? { mediaAssetId: body.mediaAssetId }
            : {}),
          ...(body.thumbnailAssetId !== undefined
            ? { thumbnailAssetId: body.thumbnailAssetId }
            : {}),
          ...(body.sourceText !== undefined
            ? { sourceText: body.sourceText }
            : {}),
          ...(body.localized !== undefined
            ? { localized: parseLocalized(body.localized, EXHIBIT_FIELDS) }
            : {}),
        },
      });
    });
  }

  async deleteExhibit(courseId: string, lessonId: string, exhibitId: string) {
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      const lesson = await this.requireLesson(courseId, lessonId, tx);
      const exhibit = lesson.exhibits.find((row) => row.id === exhibitId);
      if (!exhibit)
        throw new NotFoundException({
          code: 'EXHIBIT_NOT_FOUND',
          message: 'Exhibit not found.',
        });
      // 还被视频触发或正文引用着：不删，并说明在哪一课的哪个位置
      const active = await tx.lesson.findMany({
        where: { courseId, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      const lessonPosition = active.findIndex((row) => row.id === lessonId) + 1;
      const usages = [
        ...videoUsages(lessonPosition, lesson.triggers, exhibitId),
        ...textUsages(lessonPosition, lesson.localizations, exhibit),
      ];
      if (usages.length > 0) {
        throw new ConflictException({
          code: 'EXHIBIT_IN_USE',
          message: exhibitInUseMessage(usages),
          details: { usages },
        });
      }
      await tx.exhibit.delete({ where: { id: exhibitId } });
      return { deleted: true };
    });
  }

  /**
   * 展品排序：要给出本课时全部展品的新顺序，缺一个或多一个都不写（400）；
   * 不是本课时的展品 id 整批拒绝（404）。位置重新编成 1..N。
   */
  async reorderExhibits(courseId: string, lessonId: string, input: unknown) {
    const ids = requireArray(input, 'exhibitIds', {
      code: 'EXHIBIT_ORDER_INVALID',
    });
    if (
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    ) {
      throw new BadRequestException({
        code: 'EXHIBIT_ORDER_INVALID',
        message: 'exhibitIds must be a list of distinct exhibit ids.',
        details: { field: 'exhibitIds' },
      });
    }
    const order = ids as string[];
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      const lesson = await this.requireLesson(courseId, lessonId, tx);
      const byId = new Map(lesson.exhibits.map((row) => [row.id, row]));
      if (order.some((id) => !byId.has(id))) {
        throw new NotFoundException({
          code: 'EXHIBIT_NOT_FOUND',
          message: 'Exhibit not found.',
        });
      }
      if (order.length !== byId.size) {
        throw new BadRequestException({
          code: 'EXHIBIT_ORDER_INCOMPLETE',
          message: 'List every exhibit of the lesson exactly once.',
          details: { expected: byId.size, received: order.length },
        });
      }
      for (const [index, id] of order.entries()) {
        const row = byId.get(id);
        if (row && row.sortOrder !== index + 1) {
          await tx.exhibit.update({
            where: { id },
            data: { sortOrder: index + 1 },
          });
        }
      }
      return {
        exhibits: order.map((id, index) => ({
          id,
          code: byId.get(id)?.code ?? '',
          sortOrder: index + 1,
        })),
      };
    });
  }

  /**
   * 推荐阅读就地保存。每个课时只有一份英文列表（PRD L411）：无论请求写的是哪种语言，都存成 en-GB，
   * 课时里别的语言的旧行一并并入这一份。认出已有的行（请求里带 id）就改这一行，id 不变；
   * 请求里没有的已有行删除；`sortOrder` 跟请求顺序。标题、作者、推荐理由没填也存，
   * 只有 Type 不在 Book / Article / Paper / Other 里才 400（并且什么都不写）。
   */
  async saveReadings(
    courseId: string,
    lessonId: string,
    language: unknown,
    input: unknown,
  ) {
    void language;
    const rows = parseReadingList(input);
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      await this.requireLesson(courseId, lessonId, tx);
      const existing = await tx.recommendedReading.findMany({
        where: { lessonId },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((row) => row.id));
      const taken = new Set<string>();
      const found = rows.map((row) => {
        if (!row.id || !existingIds.has(row.id) || taken.has(row.id)) {
          return null;
        }
        taken.add(row.id);
        return row.id;
      });
      const stale = existing
        .filter((row) => !taken.has(row.id))
        .map((row) => row.id);
      if (stale.length > 0) {
        await tx.recommendedReading.deleteMany({
          where: { id: { in: stale } },
        });
      }

      const readings: Array<{
        id: string;
        type: string;
        title: string;
        author: string;
        whyRecommended: string;
        sortOrder: number;
      }> = [];
      for (const [index, row] of rows.entries()) {
        const data = {
          language: READING_LANGUAGE,
          type: row.type as ReadingType,
          title: row.title,
          author: row.author,
          whyRecommended: row.whyRecommended,
          sortOrder: index,
        };
        const id = found[index];
        const saved = id
          ? await tx.recommendedReading.update({ where: { id }, data })
          : await tx.recommendedReading.create({ data: { lessonId, ...data } });
        readings.push({
          id: saved.id,
          type: row.type,
          title: row.title,
          author: row.author,
          whyRecommended: row.whyRecommended,
          sortOrder: index,
        });
      }
      return { count: readings.length, readings };
    });
  }

  async saveKnowledgeTest(
    courseId: string,
    lessonId: string,
    enabled: boolean,
    rows: Array<{ code?: string; question: string; referenceAnswer: string }>,
  ) {
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      const lesson = await this.requireLesson(courseId, lessonId, tx);
      const language = await this.defaultLanguageOf(courseId, tx);
      await tx.knowledgeQuestion.deleteMany({ where: { lessonId, language } });
      if (enabled) {
        // 过渡写法（B14 起改为 id/code 就地更新与计数器分配）：K-{课时号}{序号}，遇到本课程里已有的编号就顺延。
        const taken = new Set(
          (
            await tx.knowledgeQuestion.findMany({
              where: { courseId },
              select: { code: true },
            })
          ).map((row) => row.code),
        );
        const lessonNo = lessonNumber(lesson.code, lesson.sortOrder);
        let sequence = 0;
        for (const [index, row] of rows.entries()) {
          let code: string;
          do {
            sequence += 1;
            code = formatKnowledgeCode(lessonNo, sequence);
          } while (taken.has(code));
          taken.add(code);
          await tx.knowledgeQuestion.create({
            data: {
              lessonId,
              courseId,
              language,
              code,
              question: required(
                row.question,
                `Question ${index + 1} is required.`,
              ),
              referenceAnswer: required(
                row.referenceAnswer,
                `Reference answer ${index + 1} is required.`,
              ),
              sortOrder: index,
            },
          });
        }
      }
      return { count: enabled ? rows.length : 0 };
    });
  }

  async saveApplicationTest(
    courseId: string,
    lessonId: string,
    body: { enabled: boolean; scenario?: string; referenceAnswer?: string },
  ) {
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      const lesson = await this.requireLesson(courseId, lessonId, tx);
      const language = await this.defaultLanguageOf(courseId, tx);
      if (!body.enabled) {
        await tx.applicationTest.deleteMany({ where: { lessonId, language } });
      } else {
        // 过渡写法（B14 起改为按语言保存、关闭只隐藏）：首次创建时给 A-{课时号}{序号}。
        const existing = await tx.applicationTest.findUnique({
          where: { lessonId_language: { lessonId, language } },
          select: { id: true },
        });
        const code = existing
          ? undefined
          : await this.freeApplicationCode(courseId, lesson, tx);
        await tx.applicationTest.upsert({
          where: { lessonId_language: { lessonId, language } },
          create: {
            lessonId,
            courseId,
            language,
            code: code as string,
            scenario: required(
              body.scenario,
              'Application question is required.',
            ),
            referenceAnswer: required(
              body.referenceAnswer,
              'Application reference answer is required.',
            ),
            enabled: true,
          },
          update: {
            scenario: required(
              body.scenario,
              'Application question is required.',
            ),
            referenceAnswer: required(
              body.referenceAnswer,
              'Application reference answer is required.',
            ),
            enabled: true,
          },
        });
      }
      return { enabled: body.enabled };
    });
  }

  async parseDocx(
    file: { originalname: string; buffer: Buffer } | undefined,
  ): Promise<{
    html: string;
    messages: Array<{ type: string; message: string }>;
  }> {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Upload a .docx file.',
      });
    }
    if (!file.originalname.toLowerCase().endsWith('.docx')) {
      throw new BadRequestException({
        code: 'DOCX_INVALID',
        message: 'Use a .docx file.',
      });
    }
    try {
      const result = await convertDocxToHtml(file.buffer);
      if (!result.html) {
        throw new BadRequestException({
          code: 'DOCX_INVALID',
          message: 'Could not read the Word document.',
        });
      }
      return {
        html: result.html,
        messages: result.warnings.map((message) => ({
          type: 'warning',
          message,
        })),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        code: 'DOCX_INVALID',
        message: 'Could not read the Word document.',
      });
    }
  }

  /**
   * 批量导入推荐阅读：表头不对就整个文件 400（不写任何东西）；否则在一个事务里把没有错误的行
   * 加到各课时英文列表的末尾，有错误的行跳过并逐行说明。返回
   * `{ rowsRead, added, byLesson: [{ lessonCode, added }], errors: [{ row, message }] }`。
   */
  async importReadings(
    courseId: string,
    file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    const table = this.readTable(file);
    const missing = missingReadingColumns(table.headers);
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'READING_COLUMNS_INVALID',
        message: 'Use the template to import readings.',
        details: { missing },
      });
    }
    return runCourseWrite(this.prisma, courseId, async (tx) => {
      const lessons = await tx.lesson.findMany({
        where: { courseId, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, code: true },
      });
      const check = checkReadingRows(
        table.rows,
        lessons.map((lesson) => lesson.code),
      );
      const lessonByCode = new Map(
        lessons.map((lesson) => [lesson.code, lesson]),
      );
      const last = await tx.recommendedReading.groupBy({
        by: ['lessonId'],
        where: { lessonId: { in: lessons.map((lesson) => lesson.id) } },
        _max: { sortOrder: true },
      });
      const nextOrder = new Map(
        last.map((row) => [row.lessonId, (row._max.sortOrder ?? -1) + 1]),
      );
      const added = new Map<string, number>();
      for (const row of check.valid) {
        const lesson = lessonByCode.get(row.lessonCode);
        if (!lesson) continue;
        const sortOrder = nextOrder.get(lesson.id) ?? 0;
        nextOrder.set(lesson.id, sortOrder + 1);
        await tx.recommendedReading.create({
          data: {
            lessonId: lesson.id,
            language: READING_LANGUAGE,
            type: row.type as ReadingType,
            title: row.title,
            author: row.author,
            whyRecommended: row.whyRecommended,
            sortOrder,
          },
        });
        added.set(row.lessonCode, (added.get(row.lessonCode) ?? 0) + 1);
      }
      return {
        rowsRead: check.rowsRead,
        added: check.valid.length,
        byLesson: lessons
          .filter((lesson) => added.has(lesson.code))
          .map((lesson) => ({
            lessonCode: lesson.code,
            added: added.get(lesson.code) ?? 0,
          })),
        errors: check.errors,
      };
    });
  }

  /** 推荐阅读导入模板（CSV，BOM 开头）：每个启用课时一行，预填 Course ID、Lesson ID 和英文课时名。 */
  async downloadReadingTemplate(courseId: string): Promise<string> {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { code: true },
    });
    if (!course) {
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    }
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { localizations: true },
    });
    return readingTemplateCsv(
      course.code,
      lessons.map((lesson) => ({
        code: lesson.code,
        title:
          lesson.localizations
            .find((loc) => loc.language === READING_LANGUAGE)
            ?.title.trim() ?? '',
      })),
    );
  }

  async importUnderstanding(
    courseId: string,
    language: string,
    file: { originalname: string; buffer: Buffer } | undefined,
    singleLessonId?: string,
  ) {
    void language;
    const rows = this.readSheet(file);
    const expected = [
      'Course ID',
      'Lesson ID',
      'Lesson title',
      'Type',
      'Question',
      'Reference answer',
    ];
    const first = rows[0] ?? {};
    const normalized = new Set(
      Object.keys(first).map((key) => this.normalizeHeader(key)),
    );
    for (const header of expected) {
      if (!normalized.has(this.normalizeHeader(header))) {
        return {
          added: 0,
          byLesson: {},
          errors: [{ row: 1, message: 'Use the template to import questions' }],
        };
      }
    }

    return runCourseWrite(this.prisma, courseId, async (tx) => {
      const defaultLanguage = await this.defaultLanguageOf(courseId, tx);
      const lessons = await tx.lesson.findMany({
        where: { courseId, archivedAt: null },
        include: { applicationTests: true },
      });
      const lessonByCode = new Map(
        lessons.map((lesson) => [lesson.code, lesson]),
      );
      const errors: Array<{ row: number; message: string }> = [];
      const byLesson: Record<string, number> = {};
      const applicationSeen = new Set<string>();
      let added = 0;

      for (const [index, row] of rows.entries()) {
        const rowNo = index + 2;
        const lessonCode = this.cell(row, 'Lesson ID', 'LessonID');
        const lesson = lessonByCode.get(lessonCode);
        if (singleLessonId && lesson?.id !== singleLessonId) continue;
        if (!lesson) {
          errors.push({
            row: rowNo,
            message: `Lesson ID ${lessonCode || '(empty)'} doesn't exist`,
          });
          continue;
        }
        const type = this.cell(row, 'Type');
        const question = this.cell(row, 'Question');
        const referenceAnswer = this.cell(
          row,
          'Reference answer',
          'Reference Answer',
        );
        if (type !== 'Knowledge' && type !== 'Application') {
          errors.push({
            row: rowNo,
            message: 'Type must be Knowledge or Application',
          });
          continue;
        }
        if (!question) {
          errors.push({ row: rowNo, message: 'Question is empty' });
          continue;
        }
        if (!referenceAnswer) {
          errors.push({ row: rowNo, message: 'Reference answer is empty' });
          continue;
        }
        if (type === 'Application') {
          if (
            defaultLanguageTest(lesson.applicationTests, defaultLanguage) ||
            applicationSeen.has(lessonCode)
          ) {
            errors.push({
              row: rowNo,
              message: `${lessonCode} already has an Application Test`,
            });
            continue;
          }
          applicationSeen.add(lessonCode);
          await tx.applicationTest.create({
            data: {
              lessonId: lesson.id,
              courseId,
              language: defaultLanguage,
              code: await this.freeApplicationCode(courseId, lesson, tx),
              scenario: question,
              referenceAnswer,
              enabled: true,
            },
          });
        } else {
          const count = await tx.knowledgeQuestion.count({
            where: { lessonId: lesson.id, language: defaultLanguage },
          });
          await tx.knowledgeQuestion.create({
            data: {
              lessonId: lesson.id,
              courseId,
              language: defaultLanguage,
              code: await this.freeKnowledgeCode(courseId, lesson, tx),
              question,
              referenceAnswer,
              sortOrder: count,
            },
          });
        }
        byLesson[lessonCode] = (byLesson[lessonCode] ?? 0) + 1;
        added++;
      }
      return { added, byLesson, errors };
    });
  }

  async downloadUnderstandingTemplate(courseId: string): Promise<string> {
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { localizations: true },
    });
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { code: true },
    });
    const lines = [
      'Course ID,Lesson ID,Lesson title,Type,Question,Reference answer',
    ];
    for (const lesson of lessons) {
      const title = lesson.localizations[0]?.title ?? lesson.code;
      lines.push(`${course?.code ?? ''},${lesson.code},${csv(title)},,`);
    }
    return lines.join('\n');
  }

  /** 供分块上传在收第一块之前就确认课程存在（避免大文件传完才发现 404）。 */
  async ensureCourseExists(courseId: string): Promise<void> {
    await this.assertCourse(courseId);
  }

  private async assertCourse(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found.',
      });
  }

  private async defaultLanguageOf(
    courseId: string,
    db: Db = this.prisma,
  ): Promise<string> {
    const course = await db.commerceCourse.findUnique({
      where: { id: courseId },
      select: { defaultContentLanguage: true },
    });
    return course?.defaultContentLanguage ?? 'en-GB';
  }

  /** 过渡用：本课程里还没被占用的 A-{课时号}{序号}。 */
  private async freeApplicationCode(
    courseId: string,
    lesson: { code: string; sortOrder: number },
    db: Db = this.prisma,
  ): Promise<string> {
    const taken = new Set(
      (
        await db.applicationTest.findMany({
          where: { courseId },
          select: { code: true },
        })
      ).map((row) => row.code),
    );
    const lessonNo = lessonNumber(lesson.code, lesson.sortOrder);
    let sequence = 1;
    while (taken.has(formatApplicationCode(lessonNo, sequence))) sequence += 1;
    return formatApplicationCode(lessonNo, sequence);
  }

  /** 过渡用：本课程里还没被占用的 K-{课时号}{序号}（第一个空位）。 */
  private async freeKnowledgeCode(
    courseId: string,
    lesson: { code: string; sortOrder: number },
    db: Db = this.prisma,
  ): Promise<string> {
    const taken = new Set(
      (
        await db.knowledgeQuestion.findMany({
          where: { courseId },
          select: { code: true },
        })
      ).map((row) => row.code),
    );
    const lessonNo = lessonNumber(lesson.code, lesson.sortOrder);
    let sequence = 1;
    while (taken.has(formatKnowledgeCode(lessonNo, sequence))) sequence += 1;
    return formatKnowledgeCode(lessonNo, sequence);
  }

  private async requireLesson(
    courseId: string,
    lessonId: string,
    db: Db = this.prisma,
  ) {
    const lesson = await db.lesson.findFirst({
      where: { id: lessonId, courseId, archivedAt: null },
      include: {
        localizations: true,
        learningPoints: true,
        exhibits: true,
        triggers: true,
      },
    });
    if (!lesson)
      throw new NotFoundException({
        code: 'LESSON_NOT_FOUND',
        message: 'Lesson not found.',
      });
    return lesson;
  }

  private async requireAsset(
    courseId: string,
    assetId: string,
    db: Db = this.prisma,
  ) {
    const asset = await db.courseMediaAsset.findFirst({
      where: { id: assetId, courseId },
    });
    if (!asset)
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Media asset not found.',
      });
    return asset;
  }

  private async nextExhibitOrder(
    lessonId: string,
    db: Db = this.prisma,
  ): Promise<number> {
    const last = await db.exhibit.findFirst({
      where: { lessonId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? 0) + 1;
  }

  /** 下一个展品编号：计数器只增不减；包导入带来的、已被占用的编号跳过。 */
  private async allocateExhibitCode(
    courseId: string,
    tx: CourseTx,
  ): Promise<string> {
    for (;;) {
      const code = formatExhibitCode(
        await allocate(tx, exhibitCounterKey(courseId)),
      );
      const taken = await tx.exhibit.findUnique({
        where: { courseId_code: { courseId, code } },
        select: { id: true },
      });
      if (!taken) return code;
    }
  }

  private assertExpectedKind(
    kind: MediaKind,
    expected?: 'COVER' | 'VIDEO' | 'IMAGE',
  ) {
    if (!expected) return;
    if (expected === 'VIDEO' && kind !== 'VIDEO') {
      throw new BadRequestException({
        code: 'VIDEO_REQUIRED',
        message: 'Please upload a video file.',
      });
    }
    if ((expected === 'IMAGE' || expected === 'COVER') && kind !== 'IMAGE') {
      throw new BadRequestException({
        code: 'IMAGE_REQUIRED',
        message: 'Please upload an image file.',
      });
    }
  }

  /** 读上传的 .xlsx / .csv（CSV 按 UTF-8，开头的 BOM 去掉）；读不出来 400。 */
  private readTable(
    file: { originalname: string; buffer: Buffer } | undefined,
  ): SheetTable {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Upload an .xlsx or .csv file.',
      });
    }
    try {
      return readSheetTable(file.buffer);
    } catch {
      throw new BadRequestException({
        code: 'SHEET_INVALID',
        message: 'Could not read the spreadsheet.',
      });
    }
  }

  private readSheet(
    file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    return this.readTable(file).rows;
  }

  private normalizeHeader(value: string): string {
    return normalizeHeader(value);
  }

  private cell(row: Record<string, unknown>, ...names: string[]): string {
    return sheetCell(row, ...names);
  }
}

function csv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
