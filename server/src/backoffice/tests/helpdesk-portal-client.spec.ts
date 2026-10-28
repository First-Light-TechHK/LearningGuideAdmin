import {
  createPortalHelpdeskClient,
  HelpdeskError,
  normaliseDetail,
  normaliseSummary,
  portalHelpdeskConfig,
} from '../modules/helpdesk/portalHelpdeskClient';

/**
 * HelpDesk Tickets v1 §4 / §5 Integration / §7：BackOffice 经 Portal 集成接口读写工单。
 * fetch 全部 mock；令牌是本地生成的测试值，不是任何真实密钥。
 */
const TEST_TOKEN = 'test-helpdesk-token-local-only';
const BASE_URL = 'http://portal.test/';
const TICKET_ID = '01920000-0000-7000-8000-000000000001';
const AGENT = { id: 'emp-1', name: 'alice' };

function json(status: number, body: unknown, type = 'application/json') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });
}

function problem(status: number, code: string, detail = 'detail') {
  return json(
    status,
    {
      type: `https://www.ilovelearningguide.com/problems/${code}`,
      title: code,
      status,
      detail,
      code,
    },
    'application/problem+json',
  );
}

const rawSummary = {
  id: TICKET_ID,
  number: 'LG-261028-0001',
  subject: 'Cannot open lesson',
  category: 'learning',
  status: 'OPEN',
  learner: { id: 'u1', email: 'learner@example.com', name: 'Lena' },
  assignee: null,
  sequence: 1,
  createdAt: '2026-10-28T01:00:00Z',
  updatedAt: '2026-10-28T01:00:00Z',
  lastMessageAt: '2026-10-28T01:00:00Z',
  lastMessageBy: 'learner',
  confirmDueAt: null,
  closedAt: null,
  closeReason: null,
  rating: null,
};

const rawDetail = {
  ...rawSummary,
  locale: 'zh-CN',
  messages: [
    {
      id: 'm1',
      authorKind: 'learner',
      authorName: 'Lena',
      body: 'Help',
      internal: false,
      attachments: [
        {
          id: 'a1',
          fileName: 'shot.png',
          contentType: 'image/png',
          size: 1234,
        },
      ],
      createdAt: '2026-10-28T01:00:00Z',
    },
  ],
  events: [
    {
      id: 'e1',
      type: 'com.ilovelearningguide.helpdesk.ticket.created',
      time: '2026-10-28T01:00:00Z',
      sequence: 1,
      data: {
        from_state: null,
        to_state: 'OPEN',
        actor: { kind: 'learner', id: 'u1', name: 'Lena' },
      },
    },
  ],
};

function client(fetchImpl: jest.Mock, timeoutMs?: number) {
  return createPortalHelpdeskClient({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    timeoutMs,
  });
}

function call(fetchImpl: jest.Mock, index = 0) {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

describe('Portal HelpDesk client', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.PORTAL_HELPDESK_BASE_URL = BASE_URL;
    process.env.PORTAL_HELPDESK_TOKEN = TEST_TOKEN;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  describe('configuration', () => {
    it('is not connected when either env var is missing, and never calls Portal', async () => {
      for (const unset of [
        'PORTAL_HELPDESK_BASE_URL',
        'PORTAL_HELPDESK_TOKEN',
      ]) {
        process.env.PORTAL_HELPDESK_BASE_URL = BASE_URL;
        process.env.PORTAL_HELPDESK_TOKEN = TEST_TOKEN;
        process.env[unset] = '  ';
        const fetchImpl = jest.fn();
        const error = await client(fetchImpl)
          .listTickets({})
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(HelpdeskError);
        expect(error).toMatchObject({
          status: 503,
          code: 'HELPDESK_NOT_CONNECTED',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    });

    it('treats a base URL that is not http(s) as not connected', () => {
      process.env.PORTAL_HELPDESK_BASE_URL = 'ftp://portal.test';
      expect(portalHelpdeskConfig()).toBeNull();
      process.env.PORTAL_HELPDESK_BASE_URL = 'not a url';
      expect(portalHelpdeskConfig()).toBeNull();
    });

    it('reads the env on every request so a rotated token applies at once', async () => {
      const fetchImpl = jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(json(200, { tickets: [], nextCursor: null })),
        );
      const portal = client(fetchImpl);
      await portal.listTickets({});
      process.env.PORTAL_HELPDESK_TOKEN = 'rotated-test-token';
      process.env.PORTAL_HELPDESK_BASE_URL = 'https://portal-2.test';
      await portal.listTickets({});
      expect(call(fetchImpl, 0).headers.authorization).toBe(
        `Bearer ${TEST_TOKEN}`,
      );
      expect(call(fetchImpl, 1).headers.authorization).toBe(
        'Bearer rotated-test-token',
      );
      expect(call(fetchImpl, 1).url).toBe(
        'https://portal-2.test/api/integration/helpdesk/tickets',
      );
    });
  });

  describe('requests', () => {
    it('lists tickets with Bearer auth and the status / q / limit / cursor query', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        json(200, {
          tickets: [rawSummary],
          nextCursor: 'c2',
          counts: { OPEN: 1 },
        }),
      );
      const result = await client(fetchImpl).listTickets({
        statuses: ['OPEN', 'ASSIGNED'],
        q: 'LG-26 x',
        limit: 20,
        cursor: 'c1',
      });
      const { url, init, headers } = call(fetchImpl);
      expect(url).toBe(
        'http://portal.test/api/integration/helpdesk/tickets?status=OPEN%2CASSIGNED&q=LG-26+x&limit=20&cursor=c1',
      );
      expect(init.method).toBe('GET');
      expect(headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(headers.accept).toContain('application/problem+json');
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].number).toBe('LG-261028-0001');
      expect(result.nextCursor).toBe('c2');
      expect(result.counts).toEqual({ OPEN: 1 });
    });

    it('omits empty query parameters', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(json(200, { tickets: [], nextCursor: null }));
      const result = await client(fetchImpl).listTickets({ q: '' });
      expect(call(fetchImpl).url).toBe(
        'http://portal.test/api/integration/helpdesk/tickets',
      );
      expect(result).toEqual({ tickets: [], nextCursor: null, counts: {} });
    });

    it('fetches one ticket by encoded id', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(json(200, rawDetail));
      const detail = await client(fetchImpl).getTicket(TICKET_ID);
      expect(call(fetchImpl).url).toBe(
        `http://portal.test/api/integration/helpdesk/tickets/${TICKET_ID}`,
      );
      expect(detail.messages[0].attachments[0].fileName).toBe('shot.png');
    });

    it('posts a message as JSON with the agent, expectedSequence and Idempotency-Key', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(json(201, rawDetail));
      const detail = await client(fetchImpl).postMessage(
        TICKET_ID,
        { body: 'Hello', internal: true, agent: AGENT, expectedSequence: 3 },
        'idem-key-1',
      );
      const { url, init, headers } = call(fetchImpl);
      expect(url).toBe(
        `http://portal.test/api/integration/helpdesk/tickets/${TICKET_ID}/messages`,
      );
      expect(init.method).toBe('POST');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['idempotency-key']).toBe('idem-key-1');
      expect(JSON.parse(init.body as string)).toEqual({
        body: 'Hello',
        internal: true,
        agent: AGENT,
        expectedSequence: 3,
      });
      expect(detail?.id).toBe(TICKET_ID);
    });

    it('posts an action as JSON', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(json(200, rawDetail));
      await client(fetchImpl).postAction(
        TICKET_ID,
        { action: 'claim', agent: AGENT, expectedSequence: 1 },
        'idem-key-2',
      );
      const { url, init, headers } = call(fetchImpl);
      expect(url).toBe(
        `http://portal.test/api/integration/helpdesk/tickets/${TICKET_ID}/actions`,
      );
      expect(headers['idempotency-key']).toBe('idem-key-2');
      expect(JSON.parse(init.body as string)).toEqual({
        action: 'claim',
        agent: AGENT,
        expectedSequence: 1,
      });
    });

    it('returns null from a write when Portal answers without a ticket body', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      await expect(
        client(fetchImpl).postAction(
          TICKET_ID,
          { action: 'claim', agent: AGENT, expectedSequence: 1 },
          'k',
        ),
      ).resolves.toBeNull();
    });
  });

  describe('problem+json mapping (RFC 9457)', () => {
    const cases: [Response, number, string][] = [
      [problem(409, 'stale_ticket'), 409, 'STALE_TICKET'],
      [problem(409, 'invalid_transition'), 409, 'INVALID_TRANSITION'],
      [problem(409, 'idempotency_conflict'), 409, 'IDEMPOTENCY_CONFLICT'],
      [problem(409, 'reopen_window_passed'), 409, 'REOPEN_WINDOW_PASSED'],
      [problem(404, 'not_found'), 404, 'TICKET_NOT_FOUND'],
      [problem(400, 'body_too_long'), 400, 'BODY_TOO_LONG'],
      [problem(422, 'weird code!'), 422, 'INVALID_INPUT'],
      [problem(503, 'integration_disabled'), 503, 'HELPDESK_NOT_CONNECTED'],
      [problem(401, 'unauthorized'), 503, 'HELPDESK_NOT_CONNECTED'],
      [problem(403, 'forbidden'), 503, 'HELPDESK_NOT_CONNECTED'],
      [problem(500, 'internal'), 502, 'HELPDESK_UNAVAILABLE'],
      [json(502, { message: 'bad gateway' }), 502, 'HELPDESK_UNAVAILABLE'],
      [new Response('oops', { status: 409 }), 409, 'CONFLICT'],
      [new Response('oops', { status: 429 }), 429, 'RATE_LIMITED'],
    ];

    it.each(cases)('maps Portal %#', async (response, status, code) => {
      const fetchImpl = jest.fn().mockResolvedValue(response);
      const error = await client(fetchImpl)
        .getTicket(TICKET_ID)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HelpdeskError);
      expect(error).toMatchObject({ status, code });
    });

    it('never forwards a Portal 401 as a 401 (that would sign the employee out)', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(problem(401, 'unauthorized'));
      const error = (await client(fetchImpl)
        .listTickets({})
        .catch((e: unknown) => e)) as HelpdeskError;
      expect(error.status).not.toBe(401);
    });

    it('keeps the Portal detail as the message for conflicts', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(problem(409, 'stale_ticket', 'Ticket changed'));
      await expect(client(fetchImpl).getTicket(TICKET_ID)).rejects.toThrow(
        'Ticket changed',
      );
    });
  });

  describe('transport failures', () => {
    it('maps a network error to 502 HELPDESK_UNAVAILABLE', async () => {
      const fetchImpl = jest
        .fn()
        .mockRejectedValue(new TypeError('fetch failed'));
      await expect(client(fetchImpl).listTickets({})).rejects.toMatchObject({
        status: 502,
        code: 'HELPDESK_UNAVAILABLE',
      });
    });

    it('times out slow Portal calls with 504', async () => {
      const fetchImpl = jest.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
              ),
            );
          }),
      );
      await expect(
        client(fetchImpl as unknown as jest.Mock, 20).listTickets({}),
      ).rejects.toMatchObject({ status: 504, code: 'HELPDESK_UNAVAILABLE' });
    });

    it('maps an unparseable success body to 502', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response('<html>', { status: 200 }));
      await expect(
        client(fetchImpl).getTicket(TICKET_ID),
      ).rejects.toMatchObject({ status: 502, code: 'HELPDESK_UNAVAILABLE' });
    });
  });

  describe('attachments', () => {
    function image(type: string, bytes: number, length?: string) {
      const headers: Record<string, string> = { 'content-type': type };
      if (length) headers['content-length'] = length;
      return new Response(new Uint8Array(bytes), { status: 200, headers });
    }

    it('returns allowed image bytes with their type', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(image('image/png; charset=binary', 10));
      const file = await client(fetchImpl).getAttachment('a1');
      expect(call(fetchImpl).url).toBe(
        'http://portal.test/api/integration/helpdesk/attachments/a1',
      );
      expect(call(fetchImpl).headers.authorization).toBe(
        `Bearer ${TEST_TOKEN}`,
      );
      expect(file.contentType).toBe('image/png');
      expect(file.data.length).toBe(10);
    });

    it('refuses anything that is not png / jpeg / webp', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(image('text/html', 10));
      await expect(client(fetchImpl).getAttachment('a1')).rejects.toMatchObject(
        { status: 502, code: 'HELPDESK_UNAVAILABLE' },
      );
    });

    it('refuses files over 5 MB', async () => {
      const big = 5 * 1024 * 1024 + 1;
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(image('image/jpeg', 1, String(big)));
      await expect(client(fetchImpl).getAttachment('a1')).rejects.toMatchObject(
        { status: 502 },
      );
      const fetchBody = jest.fn().mockResolvedValue(image('image/webp', big));
      await expect(client(fetchBody).getAttachment('a1')).rejects.toMatchObject(
        { status: 502 },
      );
    });

    it('maps a missing attachment to 404', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(problem(404, 'not_found'));
      await expect(client(fetchImpl).getAttachment('a1')).rejects.toMatchObject(
        { status: 404, code: 'ATTACHMENT_NOT_FOUND' },
      );
    });
  });

  describe('normalisation (field names fixed in one place)', () => {
    it('reads camelCase summaries and tolerates unknown fields', () => {
      const summary = normaliseSummary({ ...rawSummary, futureField: 1 });
      expect(summary).toEqual({
        id: TICKET_ID,
        number: 'LG-261028-0001',
        subject: 'Cannot open lesson',
        category: 'learning',
        status: 'OPEN',
        learner: { id: 'u1', email: 'learner@example.com', name: 'Lena' },
        assignee: null,
        sequence: 1,
        createdAt: '2026-10-28T01:00:00Z',
        updatedAt: '2026-10-28T01:00:00Z',
        lastMessageAt: '2026-10-28T01:00:00Z',
        lastMessageBy: 'learner',
        confirmDueAt: null,
        closedAt: null,
        closeReason: null,
        rating: null,
      });
    });

    it('falls back to snake_case names', () => {
      const summary = normaliseSummary({
        id: TICKET_ID,
        number: 'LG-1',
        subject: 's',
        category: 'other',
        status: 'ASSIGNED',
        user_id: 'u9',
        user_email: 'x@example.com',
        user_name: 'X',
        assignee_id: 'emp-2',
        assignee_name: 'bob',
        sequence: 4,
        created_at: 't1',
        updated_at: 't2',
        last_message_at: 't3',
        last_message_by: 'agent',
        confirm_due_at: 't4',
        closed_at: null,
        close_reason: null,
        rating: 5,
      });
      expect(summary.learner).toEqual({
        id: 'u9',
        email: 'x@example.com',
        name: 'X',
      });
      expect(summary.assignee).toEqual({ id: 'emp-2', name: 'bob' });
      expect(summary.lastMessageBy).toBe('agent');
      expect(summary.confirmDueAt).toBe('t4');
      expect(summary.rating).toBe(5);
    });

    it('shortens CloudEvents types and maps event data', () => {
      const detail = normaliseDetail(rawDetail);
      expect(detail.locale).toBe('zh-CN');
      expect(detail.events[0]).toEqual({
        id: 'e1',
        type: 'created',
        time: '2026-10-28T01:00:00Z',
        sequence: 1,
        data: {
          fromState: null,
          toState: 'OPEN',
          actor: { kind: 'learner', id: 'u1', name: 'Lena' },
          reason: null,
          messageId: null,
        },
      });
    });

    it('drops messages and events that are not objects', () => {
      const detail = normaliseDetail({
        ...rawDetail,
        messages: [null, 'x', rawDetail.messages[0]],
        events: 'nope',
      });
      expect(detail.messages).toHaveLength(1);
      expect(detail.events).toEqual([]);
    });
  });
});
