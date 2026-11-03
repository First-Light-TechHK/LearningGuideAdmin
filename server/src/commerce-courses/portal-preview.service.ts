import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { isDeployed } from '../backoffice/lib/env';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_ADMIN_PREVIEW_PATH =
  '/{locale}/portal-preview/{courseId}?token={token}';
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
 * 课程预览链接（Admin 自建 Portal 风格预览页）。
 *
 * Admin 签发短时效 token，并生成指向 Admin 预览路由的链接；
 * 预览页用员工会话读取草稿/指定版本投影，按 Portal 课程页版式渲染。
 * Portal 站点本身不需要任何改动（旧 Portal `/preview` 路由不再使用）。
 */
@Injectable()
export class PortalPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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

    // Admin 预览页与 API 同源：未配置 BACKOFFICE_APP_URL 时返回相对路径，
    // 由 Back Office 页面在当前 origin 打开，避免误指向 Portal 站点。
    const base = (
      this.configService.get<string>('BACKOFFICE_APP_URL')?.trim() ?? ''
    ).replace(/\/+$/, '');
    const template =
      this.configService.get<string>('ADMIN_PORTAL_PREVIEW_PATH')?.trim() ||
      DEFAULT_ADMIN_PREVIEW_PATH;
    const resolvedLocale = (locale ?? '').toLowerCase().startsWith('zh')
      ? 'zh-CN'
      : 'en-GB';
    const path = template
      .replace('{locale}', resolvedLocale)
      .replace('{courseId}', courseId)
      .replace('{slug}', encodeURIComponent(slug))
      .replace('{token}', encodeURIComponent(token));

    return {
      url: base ? `${base}${path.startsWith('/') ? '' : '/'}${path}` : path,
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
      { course?: { slug?: string } } | undefined;
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
      this.configService.get<string>('PORTAL_PREVIEW_SECRET')?.trim() ?? '';
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
