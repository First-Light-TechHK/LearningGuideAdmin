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
  needsReply,
  TAB_STATUSES,
  tabCounts,
} from '../modules/helpdesk/helpdeskService';
import {
  HelpdeskError,
  type PortalHelpdeskClient,
} from '../modules/helpdesk/portalHelpdeskClient';

/** HelpDesk Tickets v1 §7：看板 Tab、待回复判定、可用操作、员工身份注入、输入校验。 */
const TICKET_ID = '01920000-0000-7000-8000-000000000001';

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
    category: 'learning',
    status: 'OPEN',
    learner: { id: 'u1', email: 'l@example.com', name: 'Lena' },
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
    locale: 'en-GB',
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
    getAttachment: jest
      .fn()
      .mockResolvedValue({ contentType: 'image/png', data: Buffer.from('x') }),
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

  it('maps each tab to the Portal status filter', () => {
    expect(TAB_STATUSES).toEqual({
      needsReply: ['OPEN', 'ASSIGNED'],
      waitingUser: ['WAITING_USER'],
      awaitingConfirm: ['PENDING_CONFIRM'],
      closed: ['CLOSED', 'CANCELLED'],
      all: null,
    });
  });

  it('derives tab counts from the Portal per-status counts', () => {
    expect(
      tabCounts({
        OPEN: 2,
        ASSIGNED: 3,
        WAITING_USER: 4,
        PENDING_CONFIRM: 1,
        CLOSED: 5,
        CANCELLED: 1,
      }),
    ).toEqual({
      needsReply: 5,
      waitingUser: 4,
      awaitingConfirm: 1,
      closed: 6,
      all: 16,
    });
  });

  it('prefers a Portal needsReply count when it sends one, and ignores junk', () => {
    expect(
      tabCounts({ OPEN: 2, ASSIGNED: 3, needsReply: 4, WAITING_USER: -1 }),
    ).toEqual({
      needsReply: 4,
      waitingUser: 0,
      awaitingConfirm: 0,
      closed: 0,
      all: 5,
    });
    expect(tabCounts({ needs_reply: 1 }).needsReply).toBe(1);
  });

  it('offers only the actions the state machine allows', () => {
    const none = {
      claim: false,
      reply: false,
      internalNote: false,
      proposeResolution: false,
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
  it('lists a tab with its Portal filter, flags cards and adds tab counts', async () => {
    const portal = fakeClient();
    portal.listTickets.mockResolvedValue({
      tickets: [
        summary({ id: 'a', status: 'OPEN' }),
        summary({ id: 'b', status: 'ASSIGNED', lastMessageBy: 'agent' }),
        summary({ id: 'c', status: 'ASSIGNED', lastMessageBy: 'learner' }),
      ],
      nextCursor: 'next',
      counts: { OPEN: 1, ASSIGNED: 2 },
    });
    const result = await createHelpdeskService(portal).list({
      tab: 'needsReply',
      q: '  LG-26  ',
      cursor: 'c1',
      limit: '10',
    });
    expect(portal.listTickets).toHaveBeenCalledWith({
      statuses: ['OPEN', 'ASSIGNED'],
      q: 'LG-26',
      cursor: 'c1',
      limit: 10,
    });
    // Needs reply 只保留真正待回复的卡片
    expect(result.tickets.map((t) => [t.id, t.needsReply])).toEqual([
      ['a', true],
      ['c', true],
    ]);
    expect(result.nextCursor).toBe('next');
    expect(result.counts.needsReply).toBe(3);
  });

  it('keeps every card on other tabs and flags which need a reply', async () => {
    const portal = fakeClient();
    portal.listTickets.mockResolvedValue({
      tickets: [
        summary({ id: 'a', status: 'OPEN' }),
        summary({ id: 'b', status: 'CLOSED' }),
      ],
      nextCursor: null,
      counts: {},
    });
    const result = await createHelpdeskService(portal).list({});
    expect(portal.listTickets).toHaveBeenCalledWith({
      statuses: undefined,
      q: undefined,
      cursor: undefined,
      limit: 30,
    });
    expect(result.tickets.map((t) => t.needsReply)).toEqual([true, false]);
  });

  it('rejects an unknown tab, a long search and a bad limit', async () => {
    const service = createHelpdeskService(fakeClient());
    for (const query of [
      { tab: 'spam' },
      { q: 'x'.repeat(201) },
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
        'idem-1',
      );
      expect(portal.postMessage).toHaveBeenCalledWith(
        TICKET_ID,
        {
          body: 'Hello there',
          internal: false,
          agent: { id: 'emp-42', name: 'alice' },
          expectedSequence: 3,
        },
        'idem-1',
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
        'idem-2',
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
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects an Idempotency-Key that is too long or has odd characters', async () => {
      const service = createHelpdeskService(fakeClient());
      for (const key of ['x'.repeat(256), 'bad key\n']) {
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
          service.reply(employee, TICKET_ID, body, 'k'),
        );
        expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
      }
      expect(portal.postMessage).not.toHaveBeenCalled();
      // 5000 字整好可以
      await service.reply(
        employee,
        TICKET_ID,
        { body: 'x'.repeat(5000), internal: false, expectedSequence: 1 },
        'k',
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
        'k',
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
          'k',
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
          'idem',
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
          'idem',
        ],
        [
          TICKET_ID,
          {
            action: 'propose_resolution',
            agent: { id: 'emp-42', name: 'alice' },
            expectedSequence: 2,
          },
          'idem',
        ],
      ]);
    });

    it('refuses learner-only or unknown actions', async () => {
      const portal = fakeClient();
      const service = createHelpdeskService(portal);
      for (const action of ['confirm', 'cancel', 'close', 'rate', 'drop']) {
        const error = await rejection(
          service.act(
            employee,
            TICKET_ID,
            { action, expectedSequence: 1 },
            'k',
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
