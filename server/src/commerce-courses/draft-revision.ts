import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { from, Observable, throwError } from 'rxjs';
import { catchError, mergeMap, tap } from 'rxjs/operators';

import { PrismaService } from '../prisma/prisma.service';
import type { BackofficeRequest } from '../backoffice/nest/request-context';

/**
 * 草稿乐观并发（PRD §23："他人已更新，请刷新"）。
 *
 * 标准 HTTP 条件请求：读课程时响应头 `ETag: "r<revision>"`，写草稿时带 `If-Match`。
 * 写之前用一条 UPDATE 原子地占下 revision + 1：
 * - 当前 revision 等于 If-Match，或上一次写入就是本人（同一页面并行保存的几个请求），放行；
 * - 否则别人在你打开之后改过，返回 409 COURSE_STALE，请先刷新；
 * - 不带 If-Match（旧页面、脚本）照常写入，但同样把 revision + 1，让其他打开的页面能察觉；
 * - 处理失败时把 revision 退回，不让失败的请求制造假冲突。
 */

export const COURSE_STALE_MESSAGE =
  'This course was changed by someone else after you opened it. Refresh to see the changes.';

const ETAG = /^(?:W\/)?"r(\d+)"$/;

export function etagFor(revision: number): string {
  return `"r${revision}"`;
}

/** 解析 If-Match；没有、`*` 或格式不认识都返回 null（不做检查）。 */
export function parseIfMatch(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.trim().match(ETAG);
  return match ? Number(match[1]) : null;
}

interface Claim {
  revision: number;
  previousBy: string | null;
}

@Injectable()
export class DraftRevisionInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<BackofficeRequest>();
    const response = http.getResponse<Response>();
    const courseId = String(request.params.id);

    if (request.method === 'GET') {
      return next.handle().pipe(
        tap((body: unknown) => {
          const revision = (body as { revision?: unknown } | null)?.revision;
          if (typeof revision === 'number') {
            response.setHeader('ETag', etagFor(revision));
          }
        }),
      );
    }

    const actor = request.employee?.employeeId ?? null;
    const claim = await this.claim(
      courseId,
      actor,
      parseIfMatch(request.headers['if-match']),
    );
    if (!claim) return next.handle(); // 课程不存在：交给处理函数返回 404
    response.setHeader('ETag', etagFor(claim.revision));
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          from(this.release(courseId, claim)).pipe(
            mergeMap(() => throwError(() => error)),
          ),
        ),
      );
  }

  private async claim(
    courseId: string,
    actor: string | null,
    expected: number | null,
  ): Promise<Claim | null> {
    const [claimed] = await this.prisma.$queryRaw<Claim[]>`
      WITH old AS (
        SELECT revision, "revisionBy" FROM "CommerceCourse"
        WHERE id = ${courseId} FOR UPDATE
      )
      UPDATE "CommerceCourse" AS course
      SET revision = old.revision + 1, "revisionBy" = ${actor}::uuid
      FROM old
      WHERE course.id = ${courseId}
        AND (${expected}::int IS NULL
          OR old.revision = ${expected}::int
          OR old."revisionBy" IS NOT DISTINCT FROM ${actor}::uuid)
      RETURNING course.revision, old."revisionBy" AS "previousBy"`;
    if (claimed) return claimed;

    const current = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { revision: true },
    });
    if (!current) return null;
    throw new ConflictException({
      code: 'COURSE_STALE',
      message: COURSE_STALE_MESSAGE,
      revision: current.revision,
    });
  }

  private async release(courseId: string, claim: Claim): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "CommerceCourse"
      SET revision = revision - 1, "revisionBy" = ${claim.previousBy}::uuid
      WHERE id = ${courseId} AND revision = ${claim.revision}`;
  }
}
