import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HELPDESK_CATEGORIES,
  HELPDESK_LOCALES,
} from '../../contracts/helpdesk-qa';
import { SUGGESTION_OUTCOMES } from '../../ai/helpdesk/helpdesk-suggestion.store';
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
} from '../modules/helpdesk/portalHelpdeskClient';
import { createQuestionService } from '../modules/helpdesk/questions/questionService';
import { attachmentContentType } from '../nest/helpdesk.controller';
import { createMemoryQuestionRepository } from './helpers/memoryQuestionRepository';

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
    listResponse: Obj;
    detailResponse: Obj;
    messageRequest: Obj;
    actionRequests: Obj[];
    staleProblem: Obj;
  };
  portalToAdmin: Obj & {
    questionsResponse: Obj & { questions: Obj[] };
    suggestRequest: Obj;
    suggestResponse: { suggestion: Obj };
    outcomeRequest: Obj;
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
  });
});

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

  it('keeps the UTF-8 charset Portal declares for text attachments', () => {
    expect(attachmentContentType('text/csv')).toBe('text/csv; charset=utf-8');
    expect(attachmentContentType('text/plain')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(attachmentContentType('application/pdf')).toBe('application/pdf');
    expect(attachmentContentType('image/png')).toBe('image/png');
  });
});

describe('Helpdesk contract fixture: Admin answers Portal', () => {
  it('serves Common Questions in the contract shape', async () => {
    const questions = toAdmin.questionsResponse.questions;
    const repository = createMemoryQuestionRepository(
      questions.map((q, index) => ({
        id: text(q.id),
        locale: 'en-GB',
        category: q.category as never,
        question: text(q.question),
        answer: text(q.answer),
        keywords: ['password'],
        status: 'published',
        featured: true,
        sortOrder: index + 1,
        version: 2,
        createdBy: null,
        updatedBy: null,
        createdAt: '2026-10-28T08:35:00.000Z',
        updatedAt: '2026-10-28T08:35:00.000Z',
      })),
    );
    const service = createQuestionService({ repository });
    const result = await service.published(
      { locale: 'en-GB', featured: 'true' },
      undefined,
    );
    expect(shape(result.body as Json)).toEqual(
      shape(toAdmin.questionsResponse),
    );
    expect(result.body.questions).toEqual(questions);
  });

  it('accepts the contract suggest request and answers in the contract shape', async () => {
    const chosen = toAdmin.suggestResponse.suggestion;
    const provider: LlmProvider = {
      name: 'openrouter',
      // eslint-disable-next-line require-yield, @typescript-eslint/require-await
      async *stream() {
        return;
      },
      complete: () => Promise.resolve(JSON.stringify({ qaId: chosen.qaId })),
    };
    const service = new HelpdeskSuggestService({
      qa: {
        findCandidates: () =>
          Promise.resolve([
            {
              id: text(chosen.qaId),
              category: 'technical_support',
              question: text(chosen.question),
              answer: text(chosen.answer),
              score: 1,
            },
          ]),
      },
      providers: { get: () => provider },
      rateLimit: new MemoryRateLimitStore(),
      log: {
        record: () => Promise.resolve(),
        setOutcome: () =>
          Promise.resolve({ outcome: 'declined', changed: true }),
        purgeQueryText: () => Promise.resolve(0),
      },
      env: () => ({
        OPENROUTER_API_KEY: 'test-key-local-only',
        OPENROUTER_BASE_URL: 'http://llm.test/v1',
        HELPDESK_SUGGEST_MODEL: 'test/cheap-model',
      }),
    });
    const answer = await service.suggest(toAdmin.suggestRequest);
    expect(shape(answer as unknown as Json)).toEqual(
      shape(toAdmin.suggestResponse as unknown as Json),
    );
    expect(answer.suggestion?.answer).toBe(chosen.answer);
    const outcome = await service.recordOutcome(
      text(chosen.id),
      toAdmin.outcomeRequest,
    );
    expect(outcome).toEqual(toAdmin.outcomeResponse);
  });

  it('documents the 401 challenge the integration guard sends (see the suggest and questions RBAC specs)', () => {
    expect(toAdmin.invalidTokenProblem).toEqual({
      status: 401,
      wwwAuthenticate: 'Bearer realm="helpdesk", error="invalid_token"',
      code: 'invalid_token',
    });
  });
});
