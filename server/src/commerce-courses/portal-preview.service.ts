import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { isDeployed } from '../backoffice/lib/env';
import { PrismaService } from '../prisma/prisma.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';

const DEFAULT_PORTAL_SITE = 'https://www.ilovelearningguide.com';
const DEFAULT_PATH_TEMPLATE =
  '/{locale}/portal/courses/{slug}/preview?token={token}';
const DEFAULT_TTL_SECONDS = 10 * 60;

export interface PortalPreviewLink {
  url: string;
  token: string;
  expiresAt: string;
  source: 'draft' | 'version';
  courseId: string;
  versionId: string | null;
}

export interface PortalPreviewTokenPayload {
  v: number;
  aud: 'portal-preview';
  courseId: string;
  versionId: string | null;
  slug: string;
  source: 'draft' | 'version';
  iat: number;
  exp: number;
}

/**
 * 给 Portal 的短时效预览链接。
 *
 * Admin 只负责签发；Portal 用同一个 PORTAL_PREVIEW_SECRET 校验 token，
 * 再把对应草稿/版本渲染成与生产页面一致的组件。
 */
@Injectable()
export class PortalPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  async createLink(
    courseId: string,
    versionId?: string,
    locale?: string,
  ): Promise<PortalPreviewLink> {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        slug: true,
        liveStatus: true,
        liveVersionId: true,
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });

    if (versionId) {
      const version = await this.prisma.courseVersion.findFirst({
        where: { id: versionId, courseId },
        select: { id: true, snapshotData: true },
      });
      if (!version)
        throw new NotFoundException({
          code: 'VERSION_NOT_FOUND',
          message: 'Version not found',
        });
    }

    const slug = await this.resolveSlug(course, versionId);
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);
    const token = this.sign({
      v: 1,
      aud: 'portal-preview',
      courseId,
      versionId: versionId ?? null,
      slug,
      source: versionId ? 'version' : 'draft',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    });

    const base = (
      this.config.publicSiteUrl ||
      this.configService.get<string>('PUBLIC_SITE_URL')?.trim() ||
      DEFAULT_PORTAL_SITE
    ).replace(/\/+$/, '');
    const template =
      this.configService.get<string>('PORTAL_PREVIEW_PATH')?.trim() ||
      DEFAULT_PATH_TEMPLATE;
    const resolvedLocale = (locale ?? '').toLowerCase().startsWith('zh')
      ? 'zh-CN'
      : 'en-GB';
    const path = template
      .replace('{locale}', resolvedLocale)
      .replace('{slug}', encodeURIComponent(slug))
      .replace('{token}', encodeURIComponent(token));

    return {
      url: `${base}${path.startsWith('/') ? '' : '/'}${path}`,
      token,
      expiresAt: expiresAt.toISOString(),
      source: versionId ? 'version' : 'draft',
      courseId,
      versionId: versionId ?? null,
    };
  }

  verifyToken(token: string): PortalPreviewTokenPayload {
    const [body, signature] = (token ?? '').split('.');
    if (!body || !signature) {
      throw new UnauthorizedException({
        code: 'INVALID_PREVIEW_TOKEN',
        message: 'Invalid preview token.',
      });
    }
    const expected = createHmac('sha256', this.secret())
      .update(body)
      .digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_PREVIEW_TOKEN',
        message: 'Invalid preview token.',
      });
    }
    let payload: PortalPreviewTokenPayload;
    try {
      payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as PortalPreviewTokenPayload;
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_PREVIEW_TOKEN',
        message: 'Invalid preview token.',
      });
    }
    if (
      payload.aud !== 'portal-preview' ||
      !payload.courseId ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_PREVIEW_TOKEN',
        message: 'Preview token expired or invalid.',
      });
    }
    return payload;
  }

  private async resolveSlug(
    course: { slug: string; liveVersionId: string | null },
    versionId?: string,
  ): Promise<string> {
    const id = versionId ?? course.liveVersionId;
    if (!id) return course.slug;
    const version = await this.prisma.courseVersion.findUnique({
      where: { id },
      select: { snapshotData: true },
    });
    const snapshot = version?.snapshotData as
      | { course?: { slug?: string } }
      | undefined;
    return snapshot?.course?.slug?.trim() || course.slug;
  }

  private sign(payload: Record<string, unknown>): string {
    const secret = this.secret();
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(body)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  private secret(): string {
    const configured =
      this.configService.get<string>('PORTAL_PREVIEW_SECRET')?.trim() ??
      '';
    if (configured) return configured;

    const session =
      this.configService.get<string>('SESSION_SECRET')?.trim() ?? '';
    if (session.length >= 32) return session;

    if (isDeployed()) {
      throw new ServiceUnavailableException({
        code: 'PORTAL_PREVIEW_NOT_CONFIGURED',
        message: 'PORTAL_PREVIEW_SECRET is not configured.',
      });
    }
    return 'local-portal-preview-secret';
  }
}
