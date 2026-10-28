import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FAQ_CATEGORIES,
  HELPDESK_CATEGORIES,
  HELPDESK_LOCALES,
  type HelpdeskQaCandidate,
} from '../../contracts/helpdesk-qa';
import {
  ALL_OUTCOMES,
  SUGGESTION_OUTCOMES,
  SUGGESTION_SOURCES,
  type SuggestionLogEntry,
} from '../../ai/helpdesk/helpdesk-suggestion.store';
import { HelpdeskSuggestService } from '../../ai/helpdesk/helpdesk-suggest.service';
import { MemoryRateLimitStore } from '../../ai/rate-limit.service';
import type { LlmProvider } from '../../ai/providers/llm-provider.interface';
import type { SessionEmployee } from '../contracts/employee';
import {
  AGENT_ACTIONS,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_INLINE_TYPES,
  TICKET_STATUSES,
} from '../modules/helpdesk/contracts';
import { createHelpdeskService } from '../modules/helpdesk/helpdeskService';
import {
  createPortalHelpdeskClient,
  HelpdeskError,
  normaliseDetail,
  normaliseSummary,
} from '../modules/helpdesk/portalHelpdeskClient';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import { attachmentContentType } from '../nest/helpdesk.controller';
import { createMemoryFaqRepository } from './helpers/memoryFaqRepository';

/**
 * Portal <-> Admin Helpdesk 线上契约（两个仓库各存一份同样的
 * fixtures/helpdesk-contract.json，取自 2026-10-28 两端真实联调后脱敏）。
 * 这里锁 Admin 一侧：读得懂 Portal 的回包、发出的请求与 Portal 一致、
 * 给 Portal 的回包形状一致。令牌都是本地测试值。
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, Json>;

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'helpdesk-contract.json'), 'utf8'),
) as {
  enums: Record<string, string[]> & {
    agentProblemCode: Record<string, string[]>;
  };
  adminToPortal: Obj & {
    listRequest: string;
    timelineRequest: string;
    flaggedListRequest: string;
    listResponse: Obj & { tickets: Obj[] };
    detailResponse: Obj & { aiAssist: Obj[] };
    messageRequest: Obj;
    actionRequests: Obj[];
    staleProblem: Obj;
  };
  portalToAdmin: Obj & {
    faqsRequest: string;
    faqsSearchRequest: string;
    faqsResponse: Obj & { faqs: Obj[] };
    faqRequest: string;
    faqResponse: Obj;
    suggestRequest: Obj;
    suggestChatRequest: Obj;
    suggestChipRequest: Obj;
    suggestResponse: { suggestion: Obj };
    suggestNoMatchResponse: { suggestion: null };
    outcomeRequest: Obj;
    helpfulOutcomeRequest: Obj;
    outcomeResponse: Obj;
    invalidTokenProblem: Obj;
  };
};
const toPortal = fixture.adminToPortal;

/** 契约里的字符串字段（不是字符串就让用例失败）。 */
function text(value: Json | undefined): string {
  if (typeof value !== 'string')
    throw new Error('expected a string in the fixture');
  return value;
}
const toAdmin = fixture.portalToAdmin;

/** 形状：对象键（递归）与基本类型；null 视为通配；数组看第一项。 */
function shape(value: Json): Json {
  if (value === null) return null;
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape(value[key])]),
    );
  return typeof value;
}

function json(status: number, body: unknown, type = 'application/json') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });
}

const employee = {
  employeeId: (toPortal.messageRequest.agent as Obj).id,
  displayName: (toPortal.messageRequest.agent as Obj).name,
} as SessionEmployee;

describe('Helpdesk contract fixture: enums', () => {
  it('Admin knows exactly the values Portal sends', () => {
    expect([...TICKET_STATUSES]).toEqual(fixture.enums.ticketStatus);
    expect([...HELPDESK_CATEGORIES]).toEqual(fixture.enums.category);
    expect([...HELPDESK_LOCALES]).toEqual(fixture.enums.locale);
    expect([...AGENT_ACTIONS]).toEqual(fixture.enums.agentAction);
    expect([...ATTACHMENT_CONTENT_TYPES]).toEqual(
      fixture.enums.attachmentContentType,
    );
    expect([...ATTACHMENT_INLINE_TYPES]).toEqual(
      fixture.enums.inlineAttachmentContentType,
    );
    expect([...SUGGESTION_OUTCOMES]).toEqual(fixture.enums.suggestionOutcome);
    expect([...ALL_OUTCOMES]).toEqual(fixture.enums.assistFeedback);
    expect([...SUGGESTION_SOURCES]).toEqual(fixture.enums.assistSource);
    expect([...FAQ_CATEGORIES]).toEqual(fixture.enums.faqCategory);
  });
});

/** 契约里的请求 URL → 路径与查询参数（每个键只取一个值，与 Express 一致）。 */
function parseRequest(url: string) {
  const parsed = new URL(url, 'http://fixture.test');
  return {
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
  };
}

describe('Helpdesk contract fixture: Admin reads Portal', () => {
  it('normalises the captured detail without losing fields', () => {
    const detail = normaliseDetail(toPortal.detailResponse);
    const raw = toPortal.detailResponse;
    expect(detail.contactEmail).toBe(raw.contactEmail);
    expect(detail.preview).toBe(raw.preview);
    expect(detail.unreadByAgent).toBe(raw.unreadByAgent);
    expect(detail.tags).toEqual(raw.tags);
    expect(detail.needsReply).toBe(raw.needsReply);
    expect(detail.learner).toEqual({
      id: (raw.learner as Obj).id,
      email: (raw.learner as Obj).email,
      name: (raw.learner as Obj).name,
    });
    expect(detail.student).toEqual(raw.student);
    const subscription = raw.subscription as Obj;
    expect(detail.subscription).toEqual({
      planName: subscription.planName,
      billingCycle: subscription.billingCycle,
      status: subscription.status,
      renewalDate: subscription.renewalDate,
    });
    const files = (raw.messages as Obj[])[0].attachments as Obj[];
    expect(detail.messages[0].attachments).toEqual(
      files.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        contentType: file.contentType,
        size: file.sizeBytes,
        inline: false,
      })),
    );
    expect(detail.messages.map((m) => m.internal)).toEqual([
      false,
      true,
      false,
    ]);
    expect(detail.events.map((e) => e.type)).toEqual(
      (raw.events as Obj[]).map((e) =>
        text(e.type).replace('com.ilovelearningguide.helpdesk.ticket.', ''),
      ),
    );
    // v2: the flag and the AI assist log come through unchanged
    expect(detail.flagged).toBe(raw.flagged);
    expect(detail.aiAssist).toEqual(raw.aiAssist);
  });

  it('reads the flag on list rows', async () => {
    const service = createHelpdeskService({
      listTickets: jest.fn().mockResolvedValue({
        tickets: toPortal.listResponse.tickets.map((t) => normaliseSummary(t)),
        nextCursor: null,
        counts: {},
      }),
    } as never);
    const list = await service.list({});
    expect(list.tickets.map((t) => t.flagged)).toEqual(
      toPortal.listResponse.tickets.map((t) => t.flagged),
    );
  });

  it('turns the captured list counts into the board counts', async () => {
    const portal = {
      listTickets: jest.fn().mockResolvedValue({
        tickets: [],
        nextCursor: toPortal.listResponse.nextCursor,
        counts: toPortal.listResponse.counts,
      }),
    };
    const service = createHelpdeskService(portal as never);
    const counts = toPortal.listResponse.counts as Record<string, number>;
    const list = await service.list({});
    expect(list.counts.needsReply).toBe(counts.needs_reply);
    expect(list.counts.all).toBe(counts.all);
    expect(list.counts.CLOSED).toBe(counts.CLOSED);
  });

  it('maps every Portal problem code an agent call can get', async () => {
    const saved = { ...process.env };
    process.env.PORTAL_HELPDESK_BASE_URL = 'http://portal.test';
    process.env.PORTAL_HELPDESK_TOKEN = 'test-portal-token-local-only';
    try {
      const expected: Record<string, { status: number; code: string }> = {};
      for (const code of fixture.enums.agentProblemCode['400'])
        expected[code] = { status: 400, code: 'INVALID_INPUT' };
      for (const code of fixture.enums.agentProblemCode['401'])
        expected[code] = { status: 503, code: 'HELPDESK_NOT_CONNECTED' };
      expected.not_found = { status: 404, code: 'TICKET_NOT_FOUND' };
      for (const code of fixture.enums.agentProblemCode['409'])
        expected[code] = { status: 409, code: code.toUpperCase() };
      expected.integration_disabled = {
        status: 503,
        code: 'HELPDESK_NOT_CONNECTED',
      };
      expected.helpdesk_unavailable = {
        status: 502,
        code: 'HELPDESK_UNAVAILABLE',
      };
      for (const [status, codes] of Object.entries(
        fixture.enums.agentProblemCode,
      )) {
        for (const code of codes) {
          const client = createPortalHelpdeskClient({
            fetchImpl: () =>
              Promise.resolve(
                json(
                  Number(status),
                  { ...toPortal.staleProblem, status: Number(status), code },
                  'application/problem+json',
                ),
              ),
          });
          const error = (await client
            .getTicket(text(toPortal.detailResponse.id))
            .catch((e: unknown) => e)) as HelpdeskError;
          expect(error).toBeInstanceOf(HelpdeskError);
          expect({ code, status: error.status, mapped: error.code }).toEqual({
            code,
            status: expected[code].status,
            mapped: expected[code].code,
          });
        }
      }
    } finally {
      process.env = saved;
    }
  });
});

describe('Helpdesk contract fixture: Admin writes to Portal', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PORTAL_HELPDESK_BASE_URL = 'http://portal.test';
    process.env.PORTAL_HELPDESK_TOKEN = 'test-portal-token-local-only';
  });
  afterAll(() => {
    process.env = saved;
  });

  function recording() {
    const sent: {
      url: string;
      body: unknown;
      headers: Record<string, string>;
    }[] = [];
    const fetchImpl = jest.fn((url: string, init: RequestInit) => {
      sent.push({
        url,
        body: JSON.parse(init.body as string) as unknown,
        headers: init.headers as Record<string, string>,
      });
      return Promise.resolve(json(200, toPortal.detailResponse));
    });
    return {
      sent,
      client: createPortalHelpdeskClient({ fetchImpl: fetchImpl as never }),
    };
  }

  it('sends the contract list, student-timeline and flagged queries', async () => {
    const urls: string[] = [];
    const client = createPortalHelpdeskClient({
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json(200, toPortal.listResponse));
      }) as never,
    });
    const service = createHelpdeskService(client);
    for (const request of [
      toPortal.listRequest,
      toPortal.timelineRequest,
      toPortal.flaggedListRequest,
    ]) {
      await service.list(parseRequest(request).query);
    }
    // Admin always states its page size; every contract parameter goes out unchanged
    expect(urls).toHaveLength(3);
    urls.forEach((url, index) => {
      const expected = parseRequest(
        [
          toPortal.listRequest,
          toPortal.timelineRequest,
          toPortal.flaggedListRequest,
        ][index],
      );
      const actual = parseRequest(url);
      expect(actual.path).toBe(expected.path);
      expect(actual.query).toMatchObject(expected.query);
    });
  });

  it('sends the contract message body with the employee as agent', async () => {
    const { sent, client } = recording();
    const service = createHelpdeskService(client);
    const request = toPortal.messageRequest;
    await service.reply(
      employee,
      text(toPortal.detailResponse.id),
      {
        body: request.body,
        internal: request.internal,
        expectedSequence: request.expectedSequence,
      },
      '0192ffff-0000-7000-8000-000000000001',
    );
    expect(sent[0].body).toEqual(request);
    expect(sent[0].headers.authorization).toBe(
      'Bearer test-portal-token-local-only',
    );
  });

  it('sends each contract action body as Portal expects it', async () => {
    for (const request of toPortal.actionRequests) {
      const { sent, client } = recording();
      const service = createHelpdeskService(client);
      const { agent, ...body } = request;
      void agent;
      await service.act(
        employee,
        text(toPortal.detailResponse.id),
        body,
        '0192ffff-0000-7000-8000-000000000002',
      );
      expect(sent[0].body).toEqual(request);
    }
  });

  it('never sends a sequence Portal would refuse (Portal sequences start at 1)', async () => {
    const { sent, client } = recording();
    const service = createHelpdeskService(client);
    const error = (await service
      .reply(
        employee,
        text(toPortal.detailResponse.id),
        { body: 'x', internal: false, expectedSequence: 0 },
        undefined,
      )
      .catch((e: unknown) => e)) as HelpdeskError;
    expect(error).toBeInstanceOf(HelpdeskError);
    expect(error.code).toBe('INVALID_INPUT');
    expect(sent).toHaveLength(0);
  });

  it('keeps the charset Portal declares for text attachments, and adds none of its own', () => {
    expect(attachmentContentType('text/csv', 'utf-8')).toBe(
      'text/csv; charset=utf-8',
    );
    expect(attachmentContentType('text/plain', 'utf-16le')).toBe(
      'text/plain; charset=utf-16le',
    );
    expect(attachmentContentType('text/csv', 'utf-16be')).toBe(
      'text/csv; charset=utf-16be',
    );
    // legacy encodings (GBK, Windows-1252, ...) come with no charset
    expect(attachmentContentType('text/csv', null)).toBe('text/csv');
    expect(attachmentContentType('application/pdf', null)).toBe(
      'application/pdf',
    );
    expect(attachmentContentType('image/png', 'utf-8')).toBe('image/png');
  });
});

describe('Helpdesk contract fixture: Admin answers Portal', () => {
  const faq = toAdmin.faqResponse;

  /** 契约里那条 FAQ 存成 BackOffice 的双语记录（中文字段是本地测试值）。 */
  function storedFaq(): HelpdeskFaq {
    return {
      id: text(faq.id),
      category: faq.category as never,
      popular: faq.popular === true,
      questionEn: text(faq.question),
      answerEn: text(faq.answer),
      questionZh: '如何重置密码？',
      answerZh:
        '1. 检查垃圾邮件\n2. 在 [忘记密码](https://www.ilovelearningguide.com/zh-CN/forgot-password) 重新申请',
      keywords: ['password', 'reset'],
      status: 'published',
      version: 3,
      createdBy: null,
      updatedBy: null,
      createdAt: '2026-10-28T08:00:00.000Z',
      updatedAt: text(faq.updatedAt),
    };
  }

  it('serves the published FAQs in the contract shape', async () => {
    const repository = createMemoryFaqRepository([storedFaq()]);
    const service = createFaqService({ repository });
    const { path, query } = parseRequest(toAdmin.faqsRequest);
    expect(path).toBe('/api/integration/helpdesk/faqs');
    const result = await service.published(query, undefined);
    expect(shape(result.body as unknown as Json)).toEqual(
      shape(toAdmin.faqsResponse),
    );
    expect(result.body.faqs).toEqual(toAdmin.faqsResponse.faqs);
    expect(text(result.body.etag)).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('accepts the contract FAQ search request', async () => {
    const repository = createMemoryFaqRepository([storedFaq()]);
    const service = createFaqService({ repository });
    const { query } = parseRequest(toAdmin.faqsSearchRequest);
    const result = await service.published(query, undefined);
    expect(repository.searches[0]).toMatchObject({
      locale: query.locale,
      text: query.q,
      category: query.category,
      limit: Number(query.limit),
    });
    expect(shape({ ...result.body, faqs: [] })).toEqual(
      shape({ ...toAdmin.faqsResponse, faqs: [] }),
    );
  });

  it('serves one published FAQ in the contract shape', async () => {
    const service = createFaqService({
      repository: createMemoryFaqRepository([storedFaq()]),
    });
    const { path, query } = parseRequest(toAdmin.faqRequest);
    const id = decodeURIComponent(path.split('/').pop() as string);
    await expect(service.publishedOne(id, query)).resolves.toEqual(faq);
  });

  function suggestService(candidate: HelpdeskQaCandidate) {
    const logged: SuggestionLogEntry[] = [];
    const complete = jest.fn(() =>
      Promise.resolve(JSON.stringify({ faqId: candidate.id })),
    );
    const provider: LlmProvider = {
      name: 'openrouter',
      // eslint-disable-next-line require-yield, @typescript-eslint/require-await
      async *stream() {
        return;
      },
      complete,
    };
    const service = new HelpdeskSuggestService({
      qa: {
        findCandidates: () => Promise.resolve([candidate]),
        findPublished: (id) =>
          Promise.resolve(id === candidate.id ? candidate : null),
      },
      providers: { get: () => provider },
      rateLimit: new MemoryRateLimitStore(),
      log: {
        record: (entry) => {
          logged.push(entry);
          return Promise.resolve();
        },
        setOutcome: (_id, outcome) =>
          Promise.resolve({ kind: 'recorded', outcome, changed: true }),
        purgeQueryText: () => Promise.resolve(0),
      },
      env: () => ({
        OPENROUTER_API_KEY: 'test-key-local-only',
        OPENROUTER_BASE_URL: 'http://llm.test/v1',
        HELPDESK_SUGGEST_MODEL: 'test/cheap-model',
      }),
    });
    return { service, logged, complete };
  }

  it('accepts the submit, chat and chip suggest requests and answers with faqId', async () => {
    const chosen = toAdmin.suggestResponse.suggestion;
    const { service, logged, complete } = suggestService({
      id: text(chosen.faqId),
      category: 'account_technical',
      question: text(chosen.question),
      answer: text(chosen.answer),
      score: 1,
    });
    for (const request of [
      toAdmin.suggestRequest,
      toAdmin.suggestChatRequest,
      toAdmin.suggestChipRequest,
    ]) {
      const answer = await service.suggest(request);
      expect(shape(answer as unknown as Json)).toEqual(
        shape(toAdmin.suggestResponse as unknown as Json),
      );
      expect(answer.suggestion).toMatchObject({
        faqId: chosen.faqId,
        question: chosen.question,
        answer: chosen.answer,
      });
    }
    expect(logged.map((entry) => entry.source)).toEqual([
      'submit',
      'chat',
      'chip',
    ]);
    // the chip answer needs no model call
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('answers no match as the contract null', async () => {
    const { service } = suggestService({
      id: '0192bbbb-0000-7000-8000-0000000000ff',
      category: 'other',
      question: 'q',
      answer: 'a',
      score: 1,
    });
    await expect(
      service.suggest({
        ...toAdmin.suggestChipRequest,
        faqId: '0192bbbb-0000-7000-8000-000000000001',
      }),
    ).resolves.toEqual(toAdmin.suggestNoMatchResponse);
  });

  it('records the contract outcomes', async () => {
    const chosen = toAdmin.suggestResponse.suggestion;
    const { service } = suggestService({
      id: text(chosen.faqId),
      category: 'account_technical',
      question: text(chosen.question),
      answer: text(chosen.answer),
      score: 1,
    });
    await expect(
      service.recordOutcome(text(chosen.id), toAdmin.outcomeRequest),
    ).resolves.toEqual(toAdmin.outcomeResponse);
    await expect(
      service.recordOutcome(text(chosen.id), toAdmin.helpfulOutcomeRequest),
    ).resolves.toMatchObject({
      outcome: toAdmin.helpfulOutcomeRequest.outcome,
    });
  });

  it('documents the 401 challenge the integration guard sends (see the suggest and FAQ RBAC specs)', () => {
    expect(toAdmin.invalidTokenProblem).toEqual({
      status: 401,
      wwwAuthenticate: 'Bearer realm="helpdesk", error="invalid_token"',
      code: 'invalid_token',
    });
  });
});
