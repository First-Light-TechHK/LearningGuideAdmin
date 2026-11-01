import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ASSIST_VIAS,
  CHAT_END_REASONS,
  CLOSE_REASONS,
  INSIGHT_LIMITS,
  PII_PLACEHOLDERS,
  PORTAL_JOB_STATUSES,
  PORTAL_JOB_TRIGGERS,
  PORTAL_JOBS,
  TURN_GUARDS,
  TURN_KINDS,
} from '../modules/helpdesk/contracts';
import {
  createPortalHelpdeskClient,
  normaliseInsightsPage,
  normaliseJobRun,
} from '../modules/helpdesk/portalHelpdeskClient';

/**
 * 契约 fixture v7（v5 Part G、graph design §3 / §5.5）的 Admin 一侧：数据飞轮读 Portal 的
 * 脱敏 insights（分页、窗口固定、只有标签与脱敏文字），以及 Portal 的 180 天原文清理任务
 * （运行列表、立即运行，带 Idempotency-Key 与执行人）。fixture 与 Portal 的那份逐字节相同。
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, Json>;

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'helpdesk-contract.json'), 'utf8'),
) as {
  version: number;
  enums: Record<string, string[]>;
  adminToPortal: Obj & {
    insightsRequest: string;
    insightsResponse: Obj & { turns: Obj[] };
    insightsNextRequest: string;
    insightsLastResponse: Obj;
    insightsLimits: Record<string, number>;
    jobRunsRequest: string;
    jobRunsResponse: Obj & { runs: Obj[] };
    jobRunRequestPath: string;
    jobRunRequest: Obj;
    jobRunResponse: Obj & { run: Obj };
    jobRunAlreadyRunningResponse: Obj;
  };
};
const toPortal = fixture.adminToPortal;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function parseRequest(url: string) {
  const parsed = new URL(url, 'http://fixture.test');
  return {
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
  };
}

describe('Helpdesk contract fixture v7: enums and limits', () => {
  it('is version 7 or later', () => {
    expect(fixture.version).toBeGreaterThanOrEqual(7);
  });

  it('Admin knows exactly the turn labels, placeholders and job values Portal sends', () => {
    expect([...TURN_KINDS]).toEqual(fixture.enums.turnKind);
    expect([...TURN_GUARDS]).toEqual(fixture.enums.turnGuard);
    expect([...ASSIST_VIAS]).toEqual(fixture.enums.assistVia);
    expect([...CHAT_END_REASONS]).toEqual(fixture.enums.chatEndReason);
    expect([...CLOSE_REASONS]).toEqual(fixture.enums.closeReason);
    expect([...PII_PLACEHOLDERS]).toEqual(fixture.enums.piiPlaceholder);
    expect([...PORTAL_JOBS]).toEqual(fixture.enums.helpdeskJob);
    expect([...PORTAL_JOB_TRIGGERS]).toEqual(fixture.enums.jobTrigger);
    expect([...PORTAL_JOB_STATUSES]).toEqual(fixture.enums.jobStatus);
  });

  it('uses the same page and text limits', () => {
    expect(INSIGHT_LIMITS).toEqual(toPortal.insightsLimits);
  });
});

describe('Helpdesk contract fixture v7: Admin reads the insights feed', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PORTAL_HELPDESK_BASE_URL = 'http://portal.test';
    process.env.PORTAL_HELPDESK_TOKEN = 'test-portal-token-local-only';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('normalises the captured page without losing or adding a field', () => {
    const page = normaliseInsightsPage(toPortal.insightsResponse);
    expect(page).toEqual(toPortal.insightsResponse);
  });

  it('drops values outside the enums to null and turns without an id or time', () => {
    const [first] = toPortal.insightsResponse.turns;
    const page = normaliseInsightsPage({
      turns: [
        {
          ...first,
          kind: 'mystery',
          guard: 'new_reason',
          via: 'teleport',
          vote: 'meh',
          rating: 9,
          signals: ['payment_failed', 'not_a_signal'],
          learnerId: 'u-1',
          email: 'a@b.test',
          text: 'x'.repeat(INSIGHT_LIMITS.textMax + 50),
        },
        { ...first, id: 'not-a-uuid' },
        { ...first, createdAt: 'yesterday' },
      ],
      nextCursor: null,
      until: toPortal.insightsResponse.until,
    });
    expect(page.turns).toHaveLength(1);
    const [turn] = page.turns;
    expect(turn.kind).toBeNull();
    expect(turn.guard).toBeNull();
    expect(turn.via).toBeNull();
    expect(turn.vote).toBeNull();
    expect(turn.rating).toBeNull();
    expect(turn.signals).toEqual(['payment_failed']);
    expect(turn).not.toHaveProperty('learnerId');
    expect(turn).not.toHaveProperty('email');
    expect([...turn.text]).toHaveLength(INSIGHT_LIMITS.textMax);
  });

  it('sends the contract first and next page requests and follows the cursor', async () => {
    const urls: string[] = [];
    const responses = [
      toPortal.insightsResponse,
      toPortal.insightsLastResponse,
    ];
    const client = createPortalHelpdeskClient({
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json(200, responses[urls.length - 1]));
      }) as never,
    });
    const since = parseRequest(toPortal.insightsRequest).query.since;
    const first = await client.insights({ since, limit: 2 });
    const second = await client.insights({
      since,
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.turns).toEqual([]);
    expect(second.nextCursor).toBeNull();
    const expected = [toPortal.insightsRequest, toPortal.insightsNextRequest];
    urls.forEach((url, index) => {
      const want = parseRequest(expected[index]);
      const got = parseRequest(url);
      expect(got.path).toBe(want.path);
      expect(got.query).toEqual(want.query);
    });
  });

  it('a page that is not the contract shape is unavailable, not an empty page', async () => {
    const client = createPortalHelpdeskClient({
      fetchImpl: () => Promise.resolve(json(200, { rows: [] })),
    });
    await expect(
      client.insights({ since: '2026-10-30T00:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 502, code: 'HELPDESK_UNAVAILABLE' });
  });
});

describe('Helpdesk contract fixture v7: Portal retention job runs', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PORTAL_HELPDESK_BASE_URL = 'http://portal.test';
    process.env.PORTAL_HELPDESK_TOKEN = 'test-portal-token-local-only';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('reads the runs list exactly as Portal sends it', async () => {
    const urls: string[] = [];
    const client = createPortalHelpdeskClient({
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json(200, toPortal.jobRunsResponse));
      }) as never,
    });
    const runs = await client.assistRetentionRuns();
    expect(runs).toEqual(toPortal.jobRunsResponse);
    expect(parseRequest(urls[0]).path).toBe(toPortal.jobRunsRequest);
    expect(normaliseJobRun(toPortal.jobRunsResponse.runs[0])).toEqual(
      toPortal.jobRunsResponse.runs[0],
    );
  });

  it('sends the contract run-now body with the employee as agent and the Idempotency-Key', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const replies = [
      toPortal.jobRunResponse,
      toPortal.jobRunAlreadyRunningResponse,
    ];
    const client = createPortalHelpdeskClient({
      fetchImpl: ((url: string, init: RequestInit) => {
        sent.push({ url, init });
        return Promise.resolve(json(200, replies[sent.length - 1]));
      }) as never,
    });
    const agent = toPortal.jobRunRequest.agent as { id: string; name: string };
    const done = await client.runAssistRetention(agent, 'key-1');
    expect(done).toEqual(toPortal.jobRunResponse);
    const busy = await client.runAssistRetention(agent, 'key-2');
    expect(busy).toEqual(toPortal.jobRunAlreadyRunningResponse);
    expect(parseRequest(sent[0].url).path).toBe(toPortal.jobRunRequestPath);
    expect(sent[0].init.method).toBe('POST');
    expect(JSON.parse(sent[0].init.body as string)).toEqual(
      toPortal.jobRunRequest,
    );
    expect(
      (sent[0].init.headers as Record<string, string>)['idempotency-key'],
    ).toBe('key-1');
  });
});
