import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface TrialRowInput {
  lessonId: string;
  videoCutoffSeconds?: number | null;
  textCutoffLearningPointId?: string | null;
  videoCutoffByLanguage?: Record<string, number | null>;
  textCutoffByLanguage?: Record<string, string | null>;
}

/**
 * Trial（PRD §14）：直接引用正式学习内容，不创建试看副本。
 * 试看设置不属于版本快照：保存立即在本环境网站生效，不生成版本，Restore 不改变它。
 */
@Injectable()
export class TrialService {
  constructor(private readonly prisma: PrismaService) {}

  async get(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        trialEnabled: true,
        learningMode: true,
        learningLanguages: true,
        defaultContentLanguage: true,
        lessons: {
          where: { archivedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            code: true,
            sortOrder: true,
            localizations: {
              select: {
                language: true,
                title: true,
                videoAssetId: true,
                videoDurationSeconds: true,
              },
            },
            learningPoints: {
              where: { source: 'TEXT' },
              orderBy: { sortOrder: 'asc' },
              select: { id: true, language: true, code: true, title: true },
            },
          },
        },
        trialRows: true,
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });

    const rowByLesson = new Map(
      course.trialRows.map((row) => [row.lessonId, row]),
    );
    const rows = course.lessons.map((lesson, index) => {
      const row = rowByLesson.get(lesson.id);
      const defaultLoc =
        lesson.localizations.find(
          (loc) => loc.language === course.defaultContentLanguage,
        ) ?? lesson.localizations[0];
      const textCutoffCode =
        row?.confirmedTextCutoffCode ??
        lesson.learningPoints.find(
          (lp) => lp.id === row?.textCutoffLearningPointId,
        )?.code ??
        null;
      const status = !row
        ? 'LOCKED'
        : (row.confirmedVideoAssetId &&
              defaultLoc?.videoAssetId &&
              row.confirmedVideoAssetId !== defaultLoc.videoAssetId) ||
            (row.textCutoffLearningPointId &&
              lesson.learningPoints.some(
                (lp) => lp.id === row.textCutoffLearningPointId,
              ) === false)
          ? 'RE_CONFIRM'
          : row.status;
      return {
        lessonId: lesson.id,
        code: lesson.code,
        index: index + 1,
        title: defaultLoc?.title ?? lesson.code,
        videoDurationSeconds: defaultLoc?.videoDurationSeconds ?? null,
        inTrial: Boolean(row),
        videoCutoffSeconds: row?.videoCutoffSeconds ?? null,
        textCutoffLearningPointId: row?.textCutoffLearningPointId ?? null,
        textCutoffCode,
        videoCutoffByLanguage:
          (row?.videoCutoffByLanguage as Record<
            string,
            number | null
          > | null) ?? null,
        textCutoffByLanguage:
          (row?.textCutoffByLanguage as Record<string, string | null> | null) ??
          null,
        status,
        learningPoints: lesson.learningPoints,
        localizations: lesson.localizations,
      };
    });

    return {
      enabled: course.trialEnabled,
      learningMode: course.learningMode,
      learningLanguages: (course.learningLanguages as string[]) ?? [],
      rows,
    };
  }

  async save(
    courseId: string,
    body: {
      enabled: boolean;
      rows?: TrialRowInput[];
    },
  ) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        learningMode: true,
        defaultContentLanguage: true,
        lessons: {
          where: { archivedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            code: true,
            localizations: {
              select: {
                language: true,
                videoAssetId: true,
                videoDurationSeconds: true,
              },
            },
            learningPoints: {
              where: { source: 'TEXT' },
              select: { id: true, language: true, code: true },
            },
          },
        },
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });

    const rows = body.rows ?? [];
    if (body.enabled && rows.length > 0) {
      const allowedIds = course.lessons.map((lesson) => lesson.id);
      for (const row of rows) {
        if (!allowedIds.includes(row.lessonId)) {
          throw new ConflictException({
            code: 'TRIAL_LESSON_INVALID',
            message: 'Trial lesson does not belong to this course.',
          });
        }
      }
      // 试看 Lesson 必须从 Lesson 01 开始连续（PRD §14）
      const firstIds = course.lessons
        .slice(0, rows.length)
        .map((lesson) => lesson.id);
      if (!firstIds.every((id, index) => rows[index]?.lessonId === id)) {
        throw new ConflictException({
          code: 'TRIAL_NOT_CONTIGUOUS',
          message: 'Trial lessons must start from Lesson 1 and be consecutive.',
        });
      }
    }

    const lessonById = new Map(
      course.lessons.map((lesson) => [lesson.id, lesson]),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.trialSetting.deleteMany({ where: { courseId } });
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: { trialEnabled: Boolean(body.enabled) },
      });
      if (!body.enabled) return;
      for (const row of rows) {
        const lesson = lessonById.get(row.lessonId);
        if (!lesson) continue;
        const defaultLoc =
          lesson.localizations.find(
            (loc) => loc.language === course.defaultContentLanguage,
          ) ?? lesson.localizations[0];
        const videoCutoffs = row.videoCutoffByLanguage ?? {};
        const textCutoffs = row.textCutoffByLanguage ?? {};
        if (course.learningMode !== 'TEXT_ONLY') {
          const cutoff =
            row.videoCutoffSeconds ?? defaultLoc?.videoDurationSeconds ?? null;
          if (cutoff !== null && cutoff !== undefined) {
            if (
              !defaultLoc?.videoDurationSeconds ||
              cutoff <= 0 ||
              cutoff > defaultLoc.videoDurationSeconds
            ) {
              throw new ConflictException({
                code: 'TRIAL_CUTOFF_INVALID',
                message: `Video cut-off must be within the video duration (${lesson.code}).`,
              });
            }
          }
          for (const [language, value] of Object.entries(videoCutoffs)) {
            const loc = lesson.localizations.find(
              (entry) => entry.language === language,
            );
            if (
              value != null &&
              (!loc?.videoDurationSeconds ||
                value <= 0 ||
                value > loc.videoDurationSeconds)
            ) {
              throw new ConflictException({
                code: 'TRIAL_CUTOFF_INVALID',
                message: `Video cut-off must be within the video duration (${lesson.code}, ${language}).`,
              });
            }
          }
        }
        if (course.learningMode !== 'VIDEO_ONLY') {
          for (const value of Object.values(textCutoffs)) {
            if (value && !lesson.learningPoints.some((lp) => lp.id === value)) {
              throw new ConflictException({
                code: 'TRIAL_CUTOFF_INVALID',
                message: `Text cut-off learning point not found (${lesson.code}).`,
              });
            }
          }
        }
        const textCutoffLp = row.textCutoffLearningPointId
          ? lesson.learningPoints.find(
              (lp) => lp.id === row.textCutoffLearningPointId,
            )
          : null;
        await tx.trialSetting.create({
          data: {
            courseId,
            lessonId: row.lessonId,
            videoCutoffSeconds: row.videoCutoffSeconds ?? null,
            textCutoffLearningPointId: row.textCutoffLearningPointId ?? null,
            videoCutoffByLanguage: row.videoCutoffByLanguage ?? undefined,
            textCutoffByLanguage: row.textCutoffByLanguage ?? undefined,
            confirmedVideoAssetId: defaultLoc?.videoAssetId ?? null,
            confirmedTextCutoffCode: textCutoffLp?.code ?? null,
            status: 'READY',
          },
        });
      }
    });

    return this.get(courseId);
  }
}
