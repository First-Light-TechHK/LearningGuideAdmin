import { NotFoundException } from '@nestjs/common';
import {
  KnowledgeUnavailableError,
  type KnowledgeClient,
  type KnowledgeCourse,
  type KnowledgeRelease,
  type KnowledgeReleaseMeta,
} from '../../ks/contract/knowledge-client';

/** 读接口超时：KS 慢了不能拖住 Tutor（docs/Engine_Split_Implementation.md 规则 5） */
const DEFAULT_TIMEOUT_MS = 3_000;

export interface HttpKnowledgeClientOptions {
  baseUrl: string;
  /** KS_SERVICE_TOKEN；为空时不带 Authorization（仅本地） */
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * KnowledgeClient 的 HTTP 实现：Agent 独立部署时经 /api/ks/v1/** 调 KS。
 * 404 视为不存在（返回 null）；超时、5xx、无法解析一律抛 KnowledgeUnavailableError。
 */
export class HttpKnowledgeClient implements KnowledgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpKnowledgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getCourse(courseId: string): Promise<KnowledgeCourse | null> {
    return this.request('GET', `/courses/${encodeURIComponent(courseId)}`);
  }

  getCourseByExternalId(externalId: string): Promise<KnowledgeCourse | null> {
    return this.request(
      'GET',
      `/courses/by-external/${encodeURIComponent(externalId)}`,
    );
  }

  async listCourses(
    options: { mappedOnly?: boolean } = {},
  ): Promise<KnowledgeCourse[]> {
    const query = options.mappedOnly ? '?mapped=true' : '';
    return (
      (await this.request<KnowledgeCourse[]>('GET', `/courses${query}`)) ?? []
    );
  }

  getReleaseMeta(releaseId: string): Promise<KnowledgeReleaseMeta | null> {
    return this.request(
      'GET',
      `/releases/${encodeURIComponent(releaseId)}/meta`,
    );
  }

  getRelease(releaseId: string): Promise<KnowledgeRelease | null> {
    return this.request('GET', `/releases/${encodeURIComponent(releaseId)}`);
  }

  setTestRelease(
    courseId: string,
    releaseId: string,
  ): Promise<KnowledgeCourse> {
    return this.write(
      `/courses/${encodeURIComponent(courseId)}/tutor-test-release`,
      { releaseId },
    );
  }

  setTutorOnline(courseId: string, online: boolean): Promise<KnowledgeCourse> {
    return this.write(`/courses/${encodeURIComponent(courseId)}/tutor-online`, {
      online,
    });
  }

  private async write<T>(path: string, body: unknown): Promise<T> {
    const result = await this.request<T>('PUT', path, body);
    if (result === null) throw new NotFoundException('课程不存在');
    return result;
  }

  private async request<T>(
    method: 'GET' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.token)
      headers.authorization = `Bearer ${this.options.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/ks/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `超时 ${this.timeoutMs}ms`
          : '无法连接';
      throw new KnowledgeUnavailableError(reason);
    }
    if (response.status === 404) return null;
    if (!response.ok)
      throw new KnowledgeUnavailableError(`HTTP ${response.status}`);
    try {
      const envelope = (await response.json()) as { data?: T };
      return envelope.data ?? null;
    } catch {
      throw new KnowledgeUnavailableError('响应无法解析');
    }
  }
}
