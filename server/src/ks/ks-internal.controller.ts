import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  SetTutorOnlineDto,
  SetTutorTestReleaseDto,
} from './dto/tutor-settings.dto';
import { PrismaKnowledgeClient } from './prisma-knowledge.client';
import { MAX_PUBLISHED_TEACHING_CARDS } from './contract/teaching-package-compiler';

function found<T>(value: T | null, what: string): T {
  if (value === null) throw new NotFoundException(`${what}不存在`);
  return value;
}

/**
 * KS 内部接口 v1（/api/ks/v1/**）：KnowledgeClient 契约的 HTTP 形态，只给 Agent 调用。
 * 鉴权：Authorization: Bearer KS_SERVICE_TOKEN（route-access 的 internal 类）。
 * 只做加法；改字段含义要开 v2（docs/Engine_Split_Implementation.md）。
 */
@Controller('ks/v1')
export class KsInternalController {
  constructor(private readonly knowledge: PrismaKnowledgeClient) {}

  @Get('courses')
  listCourses(@Query('mapped') mapped?: string) {
    return this.knowledge.listCourses({ mappedOnly: mapped === 'true' });
  }

  @Get('courses/by-external/:externalId')
  async courseByExternalId(@Param('externalId') externalId: string) {
    return found(
      await this.knowledge.getCourseByExternalId(externalId),
      '课程',
    );
  }

  @Get('courses/:id')
  async course(@Param('id') id: string) {
    return found(await this.knowledge.getCourse(id), '课程');
  }

  @Post('courses/:id/draft-pages')
  draftPages(@Param('id') id: string, @Body() body: { pageIds?: unknown }) {
    const ids = Array.isArray(body?.pageIds) ? (body.pageIds as unknown[]) : [];
    const pageIds = ids
      .slice(0, 8)
      .filter(
        (value): value is string =>
          typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value),
      );
    return this.knowledge.getCourseDraftPages(id, pageIds);
  }

  @Put('courses/:id/tutor-test-release')
  async setTestRelease(
    @Param('id') id: string,
    @Body() dto: SetTutorTestReleaseDto,
  ) {
    found(await this.knowledge.getCourse(id), '课程');
    return this.knowledge.setTestRelease(id, dto.releaseId);
  }

  @Put('courses/:id/tutor-online')
  async setTutorOnline(
    @Param('id') id: string,
    @Body() dto: SetTutorOnlineDto,
  ) {
    found(await this.knowledge.getCourse(id), '课程');
    return this.knowledge.setTutorOnline(id, dto.online);
  }

  @Get('releases/:id/meta')
  async releaseMeta(@Param('id') id: string) {
    return found(await this.knowledge.getReleaseMeta(id), '发布版本');
  }

  @Get('releases/:id')
  async release(@Param('id') id: string) {
    return found(await this.knowledge.getRelease(id), '发布版本');
  }

  /** RAG 向量检索（2026-10-26 新增）：Agent 调此接口获取相关知识片段 */
  @Post('releases/:id/qa/retrieve')
  retrieveProfessorQa(
    @Param('id') id: string,
    @Body()
    body: {
      courseId?: string;
      query?: string;
      allowedIds?: unknown;
      teachingIds?: unknown;
    },
  ) {
    const teachingIds = body?.teachingIds ?? [];
    if (
      !Array.isArray(teachingIds) ||
      teachingIds.length > MAX_PUBLISHED_TEACHING_CARDS ||
      !teachingIds.every(
        (id: unknown) => typeof id === 'string' && id.length <= 200,
      )
    )
      return { status: 'missing', cardIds: [] };
    if (
      typeof body?.courseId !== 'string' ||
      typeof body.query !== 'string' ||
      body.query.length > 8000 ||
      !Array.isArray(body.allowedIds) ||
      body.allowedIds.length > MAX_PUBLISHED_TEACHING_CARDS ||
      !body.allowedIds.every(
        (item: unknown) => typeof item === 'string' && item.length <= 200,
      )
    )
      return { status: 'missing', cardIds: [] };
    return this.knowledge.retrieveProfessorQa(
      body.courseId,
      id,
      body.query,
      body.allowedIds as string[],
      teachingIds as string[],
    );
  }

  @Post('releases/:id/chunks/retrieve')
  retrieveChunks(
    @Param('id') id: string,
    @Body() body: { query: string; topK?: number },
  ) {
    return this.knowledge.retrieveChunks(id, body.query, body.topK);
  }
}
