import type { SessionEmployee } from '../contracts/employee';
import type {
  TicketDetail,
  TicketStatus,
  TicketSummary,
} from '../modules/helpdesk/contracts';
import {
  agentFor,
  availableActions,
  createHelpdeskService,
  enquiryCounts,
  needsReply,
} from '../modules/helpdesk/helpdeskService';
import {
  HelpdeskError,
  type PortalHelpdeskClient,
} from '../modules/helpdesk/portalHelpdeskClient';

/**
 * HelpDesk Tickets v1 §7 + Figma addendum §D：Enquiries 列表筛选、待回复判定、可用操作、
 * 员工身份注入、标签 / 已读动作、输入校验。
 */
const TICKET_ID = '01920000-0000-7000-8000-000000000001';
const KEY = '0192ffff-0000-7000-8000-000000000001';

const employee: SessionEmployee = {
  employeeId: 'emp-42',
  loginEmail: 'alice@example.com',
  role: 'OPERATION_ADMIN',
  displayName: 'alice',
  accountStatus: 'ACTIVE',
  emailVerification: 'VERIFIED',
  displayStatus: 'Active',
  isBootstrapAdmin: false,
};

function summary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: TICKET_ID,
    number: 'LG-261028-0001',
    subject: 'Help',
    category: 'technical_support',
    status: 'OPEN',
    locale: 'en-GB',
    learner: { id: 'u1', email: 'l@example.com', name: 'Lena' },
    contactEmail: 'l@example.com',
    preview: 'Help',
    unreadByAgent: true,
    tags: [],
    needsReply: null,
    assignee: null,
    sequence: 1,
    createdAt: 't',
    updatedAt: 't',
    lastMessageAt: 't',
    lastMessageBy: 'learner',
    confirmDueAt: null,
    closedAt: null,
    closeReason: null,
    rating: null,
    ...overrides,
  };
}

function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    ...summary(),
    student: null,
    subscription: null,
    messages: [],
    events: [],
    ...overrides,
  };
}

function fakeClient(): jest.Mocked<PortalHelpdeskClient> {
  return {
    listTickets: jest
      .fn()
      .mockResolvedValue({ tickets: [], nextCursor: null, counts: {} }),
    getTicket: jest.fn().mockResolvedValue(detail()),
    postMessage: jest.fn().mockResolvedValue(detail({ sequence: 2 })),
    postAction: jest.fn().mockResolvedValue(detail({ sequence: 2 })),
    getAttachment: jest.fn().mockResolvedValue({
      contentType: 'image/png',
      data: Buffer.from('x'),
      fileName: null,
    }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<HelpdeskError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HelpdeskError);
  return error as HelpdeskError;
}

describe('HelpDesk board rules', () => {
  it('needs a reply when OPEN, or ASSIGNED with the learner speaking last', () => {
    expect(needsReply(summary({ status: 'OPEN' }))).toBe(true);
    expect(
      needsReply(summary({ status: 'OPEN', lastMessageBy: 'agent' })),
    ).toBe(true);
    expect(
      needsReply(summary({ status: 'ASSIGNED', lastMessageBy: 'learner' })),
    ).toBe(true);
    expect(
      needsReply(summary({ status: 'ASSIGNED', lastMessageBy: 'agent' })),
    ).toBe(false);
    for (const status of [
      'WAITING_USER',
      'PENDING_CONFIRM',
      'CLOSED',
      'CANCELLED',
    ] as TicketStatus[]) {
      expect(needsReply(summary({ status, lastMessageBy: 'learner' }))).toBe(
        false,
      );
    }
  });

  it('uses the Portal needsReply flag when it sends one', () => {
    expect(
      needsReply({
        status: 'WAITING_USER',
        lastMessageBy: 'agent',
        needsReply: true,
      }),
    ).toBe(true);
    expect(
      needsReply({
        status: 'OPEN',
        lastMessageBy: 'learner',
        needsReply: false,
      }),
    ).toBe(false);
  });

  it('normalises Portal counts (needs_reply / all / per status) and ignores junk', () => {
    expect(
      enquiryCounts({
        OPEN: 2,
        ASSIGNED: 3,
        WAITING_USER: 4,
        PENDING_CONFIRM: 1,
        CLOSED: 5,
        CANCELLED: 1,
        needs_reply: 4,
        all: 16,
      }),
    ).toEqual({
      needsReply: 4,
      all: 16,
      OPEN: 2,
      ASSIGNED: 3,
      WAITING_USER: 4,
      PENDING_CONFIRM: 1,
      CLOSED: 5,
      CANCELLED: 1,
    });
    expect(enquiryCounts({ OPEN: 2, ASSIGNED: 1, WAITING_USER: -1 })).toEqual({
      needsReply: 3,
      all: 3,
      OPEN: 2,
      ASSIGNED: 1,
      WAITING_USER: 0,
      PENDING_CONFIRM: 0,
      CLOSED: 0,
      CANCELLED: 0,
    });
  });

  it('offers only the actions the state machine allows', () => {
    const none = {
      claim: false,
      reply: false,
      internalNote: false,
      proposeResolution: false,
      tag: true,
      markRead: true,
    };
    expect(availableActions('OPEN')).toEqual({
      ...none,
      claim: true,
      reply: true,
      internalNote: true,
    });
    expect(availableActions('ASSIGNED')).toEqual({
      ...none,
      reply: true,
      internalNote: true,
      proposeResolution: true,
    });
    expect(availableActions('WAITING_USER')).toEqual({
      ...none,
      reply: true,
      internalNote: true,
      proposeResolution: true,
    });
    expect(availableActions('PENDING_CONFIRM')).toEqual({
      ...none,
      internalNote: true,
    });
    expect(availableActions('CLOSED')).toEqual({ ...none, internalNote: true });
    expect(availableActions('CANCELLED')).toEqual(none);
  });

  it('uses the signed-in employee as the agent', () => {
    expect(agentFor(employee)).toEqual({ id: 'emp-42', name: 'alice' });
  });
});

describe('HelpDesk service', () => {
  it('lists enquiries with the status / category / tag / search filters', async () => {
    const portal = fakeClient();
    portal.listTickets.mockResolvedValue({
      tickets: [
        summary({ id: 'a', status: 'OPEN' }),
        summary({ id: 'b', status: 'ASSIGNED', lastMessageBy: 'agent' }),
      ],
      nextCursor: 'next',
      counts: { OPEN: 1, ASSIGNED: 1, needs_reply: 1, all: 2 },
    });
    const result = await createHelpdeskService(portal).list({
      status: 'needs_reply',
      category: 'payments_subscriptions',
      tag: ' login issue ',
      q: '  emily  ',
      cursor: 'c1',
      limit: '10',
    });
    expect(portal.listTickets).toHaveBeenCalledWith({
      status: 'needs_reply',
      category: 'payments_subscriptions',
      tag: 'login issue',
      q: 'emily',
      cursor: 'c1',
      limit: 10,
    });
    expect(result.tickets.map((t) => [t.id, t.needsReply])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(result.nextCursor).toBe('next');
    expect(result.counts).toMatchObject({ needsReply: 1, all: 2 });
  });

  it('sends no filters for "all" and uses the default page size', async () => {
    const portal = fakeClient();
    await createHelpdeskService(portal).list({ status: 'all' });
    await createHelpdeskService(portal).list({});
    for (const [query] of portal.listTickets.mock.calls) {
      expect(query).toEqual({
        status: undefined,
        category: undefined,
        tag: undefined,
        q: undefined,
        cursor: undefined,
        limit: 30,
      });
    }
  });

  it('accepts every single Portal status', async () => {
    const portal = fakeClient();
    for (const status of [
      'OPEN',
      'ASSIGNED',
      'WAITING_USER',
      'PENDING_CONFIRM',
      'CLOSED',
      'CANCELLED',
    ]) {
      await createHelpdeskService(portal).list({ status });
    }
    expect(portal.listTickets).toHaveBeenCalledTimes(6);
  });

  it('rejects unknown filters, a long search or tag, and a bad limit', async () => {
    const service = createHelpdeskService(fakeClient());
    for (const query of [
      { status: 'spam' },
      { status: 'OPEN,ASSIGNED' },
      { category: 'billing' },
      { tag: 't'.repeat(33) },
      { q: 'x'.repeat(121) },
      { limit: '0' },
      { limit: '101' },
      { limit: 'abc' },
      { cursor: 'x'.repeat(513) },
    ]) {
      const error = await rejection(service.list(query));
      expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
  });

  it('returns detail with needsReply and the available actions', async () => {
    const portal = fakeClient();
    portal.getTicket.mockResolvedValue(detail({ status: 'WAITING_USER' }));
    const result = await createHelpdeskService(portal).detail(TICKET_ID);
    expect(portal.getTicket).toHaveBeenCalledWith(TICKET_ID);
    expect(result.needsReply).toBe(false);
    expect(result.available.proposeResolution).toBe(true);
  });

  it('rejects ticket ids that are not UUIDs before calling Portal', async () => {
    const portal = fakeClient();
    const error = await rejection(
      createHelpdeskService(portal).detail('../../users'),
    );
    expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(portal.getTicket).not.toHaveBeenCalled();
  });

  describe('replies', () => {
    it('injects the signed-in employee as agent, ignoring any agent in the body', async () => {
      const portal = fakeClient();
      const result = await createHelpdeskService(portal).reply(
        employee,
        TICKET_ID,
        {
          body: '  Hello there  ',
          internal: false,
          expectedSequence: 3,
          agent: { id: 'someone-else', name: 'mallory' },
        },
        KEY,
      );
      expect(portal.postMessage).toHaveBeenCalledWith(
        TICKET_ID,
        {
          body: 'Hello there',
          internal: false,
          agent: { id: 'emp-42', name: 'alice' },
          expectedSequence: 3,
        },
        KEY,
      );
      expect(result.sequence).toBe(2);
      expect(result.available).toBeDefined();
    });

    it('marks internal notes', async () => {
      const portal = fakeClient();
      await createHelpdeskService(portal).reply(
        employee,
        TICKET_ID,
        { body: 'note', internal: true, expectedSequence: 0 },
        KEY,
      );
      expect(portal.postMessage.mock.calls[0][1].internal).toBe(true);
    });

    it('generates an Idempotency-Key when the browser did not send one', async () => {
      const portal = fakeClient();
      await createHelpdeskService(portal).reply(
        employee,
        TICKET_ID,
        { body: 'x', internal: false, expectedSequence: 1 },
        undefined,
      );
      const key = portal.postMessage.mock.calls[0][2];
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('rejects an Idempotency-Key that is not a UUID (Portal only accepts UUIDs)', async () => {
      const service = createHelpdeskService(fakeClient());
      for (const key of ['x'.repeat(256), 'bad key\n', 'idem-1']) {
        const error = await rejection(
          service.reply(
            employee,
            TICKET_ID,
            { body: 'x', internal: false, expectedSequence: 1 },
            key,
          ),
        );
        expect(error.code).toBe('INVALID_INPUT');
      }
    });

    it('validates body (1-5000), internal flag and expectedSequence', async () => {
      const portal = fakeClient();
      const service = createHelpdeskService(portal);
      for (const body of [
        { body: '   ', internal: false, expectedSequence: 1 },
        { body: 'x'.repeat(5001), internal: false, expectedSequence: 1 },
        { body: 'ok', internal: 'yes', expectedSequence: 1 },
        { body: 'ok', internal: false },
        { body: 'ok', internal: false, expectedSequence: -1 },
        { body: 'ok', internal: false, expectedSequence: 1.5 },
        null,
      ]) {
        const error = await rejection(
          service.reply(employee, TICKET_ID, body, KEY),
        );
        expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
      }
      expect(portal.postMessage).not.toHaveBeenCalled();
      // 5000 字整好可以
      await service.reply(
        employee,
        TICKET_ID,
        { body: 'x'.repeat(5000), internal: false, expectedSequence: 1 },
        KEY,
      );
      expect(portal.postMessage).toHaveBeenCalledTimes(1);
    });

    it('re-reads the ticket when Portal answers a write without a body', async () => {
      const portal = fakeClient();
      portal.postMessage.mockResolvedValue(null);
      portal.getTicket.mockResolvedValue(detail({ sequence: 9 }));
      const result = await createHelpdeskService(portal).reply(
        employee,
        TICKET_ID,
        { body: 'x', internal: false, expectedSequence: 1 },
        KEY,
      );
      expect(portal.getTicket).toHaveBeenCalledWith(TICKET_ID);
      expect(result.sequence).toBe(9);
    });

    it('passes a stale-ticket conflict through unchanged', async () => {
      const portal = fakeClient();
      portal.postMessage.mockRejectedValue(
        new HelpdeskError(409, 'STALE_TICKET', 'changed'),
      );
      const error = await rejection(
        createHelpdeskService(portal).reply(
          employee,
          TICKET_ID,
          { body: 'x', internal: false, expectedSequence: 1 },
          KEY,
        ),
      );
      expect(error).toMatchObject({ status: 409, code: 'STALE_TICKET' });
    });
  });

  describe('actions', () => {
    it('claims and proposes resolution as the signed-in employee', async () => {
      const portal = fakeClient();
      const service = createHelpdeskService(portal);
      for (const action of ['claim', 'propose_resolution'] as const) {
        await service.act(
          employee,
          TICKET_ID,
          { action, expectedSequence: 2, agent: { id: 'x', name: 'y' } },
          KEY,
        );
      }
      expect(portal.postAction.mock.calls).toEqual([
        [
          TICKET_ID,
          {
            action: 'claim',
            agent: { id: 'emp-42', name: 'alice' },
            expectedSequence: 2,
          },
          KEY,
        ],
        [
          TICKET_ID,
          {
            action: 'propose_resolution',
            agent: { id: 'emp-42', name: 'alice' },
            expectedSequence: 2,
          },
          KEY,
        ],
      ]);
    });

    it('adds and removes a tag (trimmed, inner spaces collapsed) as the signed-in employee', async () => {
      const portal = fakeClient();
      const service = createHelpdeskService(portal);
      await service.act(
        employee,
        TICKET_ID,
        { action: 'add_tag', tag: '  login   issue ', expectedSequence: 4 },
        KEY,
      );
      await service.act(
        employee,
        TICKET_ID,
        { action: 'remove_tag', tag: 'payment', expectedSequence: 5 },
        KEY,
      );
      expect(portal.postAction.mock.calls.map((c) => c[1])).toEqual([
        {
          action: 'add_tag',
          tag: 'login issue',
          agent: { id: 'emp-42', name: 'alice' },
          expectedSequence: 4,
        },
        {
          action: 'remove_tag',
          tag: 'payment',
          agent: { id: 'emp-42', name: 'alice' },
          expectedSequence: 5,
        },
      ]);
    });

    it('validates tags: 1-32 characters, no control characters', async () => {
      const portal = fakeClient();
      const service = createHelpdeskService(portal);
      for (const tag of [undefined, '', '   ', 't'.repeat(33), 'a\u0000b', 7]) {
        const error = await rejection(
          service.act(
            employee,
            TICKET_ID,
            { action: 'add_tag', tag, expectedSequence: 1 },
            KEY,
          ),
        );
        expect(error.code).toBe('INVALID_INPUT');
      }
      await service.act(
        employee,
        TICKET_ID,
        { action: 'add_tag', tag: 't'.repeat(32), expectedSequence: 1 },
        KEY,
      );
      expect(portal.postAction).toHaveBeenCalledTimes(1);
    });

    it('marks a ticket read; expectedSequence is optional only for mark_read', async () => {
      const portal = fakeClient();
      const service = createHelpdeskService(portal);
      await service.act(employee, TICKET_ID, { action: 'mark_read' }, KEY);
      expect(portal.postAction.mock.calls[0][1]).toEqual({
        action: 'mark_read',
        agent: { id: 'emp-42', name: 'alice' },
      });
      await service.act(
        employee,
        TICKET_ID,
        { action: 'mark_read', expectedSequence: 3 },
        KEY,
      );
      expect(portal.postAction.mock.calls[1][1]).toMatchObject({
        expectedSequence: 3,
      });
      const error = await rejection(
        service.act(employee, TICKET_ID, { action: 'claim' }, KEY),
      );
      expect(error.code).toBe('INVALID_INPUT');
    });

    it('refuses learner-only or unknown actions', async () => {
      const portal = fakeClient();
      const service = createHelpdeskService(portal);
      for (const action of [
        'confirm',
        'cancel',
        'close',
        'rate',
        'drop',
        'tag',
      ]) {
        const error = await rejection(
          service.act(
            employee,
            TICKET_ID,
            { action, expectedSequence: 1 },
            KEY,
          ),
        );
        expect(error.code).toBe('INVALID_INPUT');
      }
      expect(portal.postAction).not.toHaveBeenCalled();
    });
  });

  it('proxies attachments only for safe ids', async () => {
    const portal = fakeClient();
    const service = createHelpdeskService(portal);
    await expect(service.attachment('a1-b2_C3')).resolves.toMatchObject({
      contentType: 'image/png',
    });
    const error = await rejection(service.attachment('../secret'));
    expect(error.code).toBe('INVALID_INPUT');
    expect(portal.getAttachment).toHaveBeenCalledTimes(1);
  });
});
