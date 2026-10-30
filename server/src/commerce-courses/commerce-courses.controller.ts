import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import JSZip from 'jszip';
import type { Response } from 'express';

import { CommerceCoursesService } from './commerce-courses.service';
import { PackageJobsService } from './package-jobs.service';
import { PackageWorker } from './package-worker';
import { PackageError } from './package-inspector';
import { PublishingService } from './publishing.service';
import { TrialService } from './trial.service';
import { PricingService } from './pricing.service';
import { PreviewService } from './preview.service';
import type { BackofficeRequest } from '../backoffice/nest/request-context';

function actor(request: BackofficeRequest): string | null {
  return request.employee?.employeeId ?? null;
}

function contentTypeFor(extension: string): string {
  const ext = (extension || '').toLowerCase().replace(/^\./, '');
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mp3':
      return 'audio/mpeg';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    if (error instanceof PackageError) {
      throw error;
    }
    throw error;
  });
}

/**
 * 商品课程 v2 管理接口（P1a：列表/详情/工作流/导入导出）。
 * RBAC 见 backoffice route-access：courses/* 走 knowledge 菜单，导入导出要求 FULL。
 */
@Controller('backoffice/courses')
export class CommerceCoursesController {
  constructor(
    private readonly courses: CommerceCoursesService,
    private readonly jobs: PackageJobsService,
    private readonly worker: PackageWorker,
    private readonly publishing: PublishingService,
    private readonly trial: TrialService,
    private readonly pricing: PricingService,
    private readonly preview: PreviewService,
  ) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('lifecycleStatus') lifecycleStatus?: string,
    @Query('liveStatus') liveStatus?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.courses.list({
      search,
      lifecycleStatus,
      liveStatus,
      categoryId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post()
  @HttpCode(201)
  create(
    @Body()
    body: {
      code: string;
      slug?: string;
      title: string;
      language?: string;
      learningMode?: string;
      defaultContentLanguage?: string;
      learningLanguages?: string[];
      subtitle?: string | null;
      categoryId?: string | null;
    },
    @Req() request: BackofficeRequest,
  ) {
    return this.courses.createCourse(body, actor(request));
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.courses.detail(id);
  }

  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.publishing.listVersions(id);
  }

  @Get(':id/versions/:versionId')
  version(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.publishing.getVersion(id, versionId);
  }

  @Get(':id/history')
  history(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.publishing.listHistory(id, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id/preview')
  previewCourse(
    @Param('id') id: string,
    @Query('versionId') versionId?: string,
  ) {
    return this.preview.preview(id, versionId || undefined);
  }

  // ===== 预览媒体（Admin 课程页展示封面 / 视频 / 展品图） =====
  @Get(':id/cover')
  async cover(@Param('id') id: string, @Res() res: Response) {
    const media = await this.courses.getCoverBytes(id);
    if (!media)
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Cover not found.');
    res.setHeader('Content-Type', contentTypeFor(media.extension));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(media.bytes);
  }

  @Get(':id/media/:assetId')
  async media(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const media = await this.courses.getMediaBytes(id, assetId);
    if (!media)
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Media not found.');
    res.setHeader('Content-Type', contentTypeFor(media.extension));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(media.bytes);
  }

  // ===== 编辑工作区（第一版） =====
  @Put(':id')
  @HttpCode(200)
  updateCourse(
    @Param('id') id: string,
    @Body()
    body: {
      code?: string;
      slug?: string;
      learningMode?: string;
      defaultContentLanguage?: string;
      learningLanguages?: string[];
      subtitle?: string | null;
      level?: string | null;
    },
  ) {
    return this.courses.updateCourse(id, body);
  }

  @Put(':id/localizations/:language')
  @HttpCode(200)
  updateLocalization(
    @Param('id') id: string,
    @Param('language') language: string,
    @Body()
    body: {
      title: string;
      shortDescription?: string | null;
      overview?: string | null;
      whatYouLearn?: unknown;
      provides?: unknown;
    },
  ) {
    return this.courses.updateLocalization(id, language, body);
  }

  @Post(':id/lessons')
  @HttpCode(201)
  createLesson(
    @Param('id') id: string,
    @Body() body: { code?: string; language?: string; title: string },
  ) {
    return this.courses.createLesson(id, body);
  }

  @Put(':id/lessons/reorder')
  @HttpCode(200)
  reorderLessons(
    @Param('id') id: string,
    @Body() body: { lessonIds: string[] },
  ) {
    return this.courses.reorderLessons(id, body.lessonIds);
  }

  @Put(':id/lessons/:lessonId')
  @HttpCode(200)
  updateLesson(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: {
      code?: string;
      sortOrder?: number;
      language?: string;
      title?: string;
      description?: string | null;
      textHtml?: string | null;
    },
  ) {
    return this.courses.updateLesson(id, lessonId, body);
  }

  @Delete(':id/lessons/:lessonId')
  @HttpCode(200)
  deleteLesson(@Param('id') id: string, @Param('lessonId') lessonId: string) {
    return this.courses.deleteLesson(id, lessonId);
  }

  // ===== 草稿 / 发布 / 版本（PRD §15）=====
  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @Param('id') id: string,
    @Body() body: { notifyLearners?: boolean },
    @Req() request: BackofficeRequest,
  ) {
    return this.publishing.publish(id, actor(request), body ?? {});
  }

  @Post(':id/delete-draft')
  @HttpCode(200)
  deleteDraft(@Param('id') id: string, @Req() request: BackofficeRequest) {
    return this.publishing.deleteDraft(id, actor(request));
  }

  @Post(':id/live-status')
  @HttpCode(200)
  changeStatus(
    @Param('id') id: string,
    @Body() body: { status: 'ONLINE' | 'HIDDEN' | 'OFFLINE'; reason?: string },
    @Req() request: BackofficeRequest,
  ) {
    return this.publishing.changeStatus(id, body, actor(request));
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @Param('id') id: string,
    @Body() body: { versionId: string },
    @Req() request: BackofficeRequest,
  ) {
    return this.publishing.restore(id, body.versionId, actor(request));
  }

  // ===== Trial（不生成版本，PRD §14）=====
  @Get(':id/trial')
  getTrial(@Param('id') id: string) {
    return this.trial.get(id);
  }

  @Put(':id/trial')
  @HttpCode(200)
  saveTrial(
    @Param('id') id: string,
    @Body()
    body: {
      enabled: boolean;
      rows?: Array<{
        lessonId: string;
        videoCutoffSeconds?: number | null;
        textCutoffLearningPointId?: string | null;
        videoCutoffByLanguage?: Record<string, number | null>;
        textCutoffByLanguage?: Record<string, string | null>;
      }>;
    },
  ) {
    return this.trial.save(id, body);
  }

  // ===== Pricing（不生成版本，PRD §14）=====
  @Get(':id/plans')
  listPlans(@Param('id') id: string) {
    return this.pricing.list(id);
  }

  @Put(':id/plans')
  @HttpCode(200)
  savePlans(
    @Param('id') id: string,
    @Body()
    body: {
      plans: Array<{
        id?: string;
        name: string;
        termMonths: number;
        amountMinor: number;
        currency?: string;
        lookupKey?: string;
      }>;
    },
  ) {
    return this.pricing.save(id, body?.plans ?? []);
  }

  @Post(':id/plans/:planId/sync-stripe')
  @HttpCode(200)
  syncPlan(@Param('id') id: string, @Param('planId') planId: string) {
    return this.pricing.syncPlan(id, planId);
  }

  // ===== 原始素材导入（Excel + Word/视频/图片素材 ZIP） =====
  @Post('import/raw')
  @UseInterceptors(FileInterceptor('file'))
  importRaw(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Req() request: BackofficeRequest,
  ) {
    if (!file?.buffer) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'No raw materials archive uploaded.',
      );
    }
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'Raw course materials must be uploaded as a .zip archive.',
      );
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    return wrap(() =>
      this.jobs.createRawImportJob(
        { name: file.originalname, bytes: file.buffer },
        actor(request),
        idempotencyKey,
      ),
    );
  }

  // ===== 本地目录导入（服务端直接读取仓库内 docs 素材，规避浏览器上传大文件中断） =====
  @Post('import/local')
  @HttpCode(201)
  importLocal(
    @Body() body: { dir?: string; courseCode?: string; slug?: string },
    @Req() request: BackofficeRequest,
  ) {
    return wrap(() =>
      this.jobs.createLocalRawImportJob(body ?? {}, actor(request)),
    );
  }

  // ===== 导入到已有课程（只替换草稿，CM16）=====
  @Post(':id/import')
  @UseInterceptors(FileInterceptor('file'))
  async importIntoCourse(
    @Param('id') id: string,
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Req() request: BackofficeRequest,
  ) {
    await this.courses.assertExists(id);
    if (!file?.buffer) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'No package file uploaded.',
      );
    }
    if (
      !file.originalname.toLowerCase().endsWith('.zip') &&
      !file.originalname.toLowerCase().endsWith('.lgcourse.zip')
    ) {
      throw new PackageError(
        'PACKAGE_NOT_A_COURSE',
        422,
        'Only .lgcourse.zip course packages can be imported.',
      );
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    return wrap(() =>
      this.jobs.createImportJob(
        { name: file.originalname, bytes: file.buffer },
        actor(request),
        idempotencyKey,
        id,
      ),
    );
  }

  // ===== 导入 =====
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async import(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Req() request: BackofficeRequest,
  ) {
    if (!file?.buffer) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'No package file uploaded.',
      );
    }
    if (
      !file.originalname.toLowerCase().endsWith('.zip') &&
      !file.originalname.toLowerCase().endsWith('.lgcourse.zip')
    ) {
      throw new PackageError(
        'PACKAGE_NOT_A_COURSE',
        422,
        'Only .zip course packages or raw-material archives can be imported.',
      );
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    // 智能识别：zip 内没有 manifest.json 但含 xlsx（原始素材包）时，自动走原始素材导入。
    const isRaw = await this.looksLikeRawMaterials(file.buffer);
    return wrap(() =>
      isRaw
        ? this.jobs.createRawImportJob(
            { name: file.originalname, bytes: file.buffer },
            actor(request),
            idempotencyKey,
          )
        : this.jobs.createImportJob(
            { name: file.originalname, bytes: file.buffer },
            actor(request),
            idempotencyKey,
          ),
    );
  }

  /** zip 内是否存在 manifest.json；不存在且含 .xlsx 视为原始素材包。 */
  private async looksLikeRawMaterials(bytes: Buffer): Promise<boolean> {
    try {
      const zip = await JSZip.loadAsync(bytes);
      const names = Object.keys(zip.files);
      if (
        names.some((n) => n === 'manifest.json' || n.endsWith('/manifest.json'))
      )
        return false;
      return names.some((n) => /\.xlsx$/i.test(n));
    } catch {
      return false;
    }
  }

  @Get('import/:jobId')
  importStatus(@Param('jobId') jobId: string) {
    return this.jobs.getJob(jobId);
  }

  @Post('import/:jobId/confirm')
  @HttpCode(200)
  confirmImport(
    @Param('jobId') jobId: string,
    @Body()
    body: {
      onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
      reassignCodes?: boolean;
    },
    @Req() request: BackofficeRequest,
  ) {
    return wrap(() => this.jobs.confirmImport(jobId, body, actor(request)));
  }

  @Post('import/:jobId/cancel')
  @HttpCode(200)
  cancelImport(@Param('jobId') jobId: string) {
    return this.jobs.cancelJob(jobId);
  }

  // ===== 导出 =====
  @Post(':id/export')
  @HttpCode(202)
  export(
    @Param('id') id: string,
    @Body() body: { version?: string },
    @Req() request: BackofficeRequest,
  ) {
    return wrap(() =>
      this.jobs.startExport(
        id,
        actor(request),
        body?.version,
      ),
    );
  }

  @Get('export/:jobId')
  exportStatus(@Param('jobId') jobId: string) {
    return this.jobs.getJob(jobId);
  }

  @Get('export/:jobId/download')
  async download(@Param('jobId') jobId: string, @Res() res: Response) {
    const bytes = await this.worker.readExport(jobId);
    if (!bytes) {
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Export not ready.');
    }
    const job = await this.jobs.getJob(jobId);
    const fileName = job.fileLabel ?? `course-${jobId}.lgcourse.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(bytes);
  }

  // ===== 作业列表 =====
  @Get('jobs/list')
  jobsList(@Req() request: BackofficeRequest) {
    return this.jobs.listJobs(actor(request));
  }
}
