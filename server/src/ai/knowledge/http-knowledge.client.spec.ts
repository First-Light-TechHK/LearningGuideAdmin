import { NotFoundException } from '@nestjs/common';
import { KnowledgeUnavailableError } from '../../ks/contract/knowledge-client';
import { HttpKnowledgeClient } from './http-knowledge.client';

const course = {
  id: 'c1',
  title: '课程',
  externalId: 'slug',
  currentReleaseId: 'r1',
  aiTestReleaseId: null,
  aiTutorOnline: true,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: jest.Mock, timeoutMs?: number) {
  return new HttpKnowledgeClient({
    baseUrl: 'http://ks.internal/',
    token: 'tok',
    timeoutMs,
    fetchImpl,
  });
}

describe('HttpKnowledgeClient（Agent 经 HTTP 读 KS）', () => {
  it('带 Bearer 令牌调 /api/ks/v1，解开统一信封', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(json(200, { success: true, data: course }));
    await expect(client(fetchImpl).getCourse('c 1')).resolves.toEqual(course);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ks.internal/api/ks/v1/courses/c%201');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer tok',
    );
  });

  it('忽略不认识的字段（契约只做加法）', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        json(200, { success: true, data: [{ ...course, futureField: 1 }] }),
      );
    const list = await client(fetchImpl).listCourses({ mappedOnly: true });
    expect(list[0].id).toBe('c1');
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
      'http://ks.internal/api/ks/v1/courses?mapped=true',
    );
  });

  it('404 视为不存在，返回 null', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(404, {}));
    await expect(client(fetchImpl).getRelease('r9')).resolves.toBeNull();
  });

  it('写接口遇到 404 抛 NotFound，而不是当成 KS 故障', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(404, {}));
    await expect(
      client(fetchImpl).setTutorOnline('missing', true),
    ).rejects.toBeInstanceOf(NotFoundException);
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ online: true }));
  });

  it('5xx、连不上、超时都抛 KnowledgeUnavailableError（503）', async () => {
    await expect(
      client(jest.fn().mockResolvedValue(json(502, {}))).getCourse('c1'),
    ).rejects.toBeInstanceOf(KnowledgeUnavailableError);
    await expect(
      client(
        jest.fn().mockRejectedValue(new TypeError('fetch failed')),
      ).getCourse('c1'),
    ).rejects.toBeInstanceOf(KnowledgeUnavailableError);
    const hang = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason as Error),
          );
        }),
    );
    const error = await client(hang, 20)
      .getCourse('c1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnowledgeUnavailableError);
    expect((error as KnowledgeUnavailableError).getStatus()).toBe(503);
  });
});
