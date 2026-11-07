import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  TUTOR_IMAGE_SOURCE,
  type TutorImageSource,
} from '../contracts/tutor-image';
import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';

@Controller('user/courses')
export class LearnerImageController {
  constructor(
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
    @Inject(TUTOR_IMAGE_SOURCE) private readonly files: TutorImageSource,
  ) {}

  @Get(':externalId/images/:assetId')
  async getImage(
    @Param('externalId') externalId: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/i.test(
        assetId,
      )
    )
      throw new NotFoundException('图片不存在');
    const course = await this.knowledge.getCourseByExternalId(externalId);
    if (!course?.aiTutorOnline || !course.currentReleaseId)
      throw new NotFoundException('图片不存在');
    const release = await this.knowledge.getRelease(course.currentReleaseId);
    const url = `/api/files/images/${course.id}/${assetId}`;
    if (
      release?.id !== course.currentReleaseId ||
      release.courseId !== course.id ||
      !release.pages.some((page) =>
        [
          ...(page.contentMd ?? '').matchAll(/!\[[^\]\n]*\]\(([^\s)]+)\)/g),
        ].some((match) => match[1] === url),
      )
    )
      throw new NotFoundException('图片不存在');
    const image = await this.files.getImage(course.id, assetId);
    if (!image) throw new NotFoundException('图片不存在');
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image.bytes);
  }
}
