import type { SessionEmployee } from '../contracts/employee';
import type { HelpdeskSuggestionStats } from '../../contracts/helpdesk-qa';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import type { HelpdeskQuestion } from '../modules/helpdesk/questions/questionContracts';
import {
  createQuestionService,
  publishedEtag,
} from '../modules/helpdesk/questions/questionService';
import { createMemoryQuestionRepository } from './helpers/memoryQuestionRepository';

/**
 * Helpdesk addendum §A：Common Questions 数据层。Admin 是唯一写入方；
 * 每次修改带 version（不一致 409），修订行与修改同一次写入；Portal 只读已发布的。
 */
const employee = {
  employeeId: '0192aaaa-0000-7000-8000-000000000001',
  displayName: 'alice',
} as SessionEmployee;

function question(overrides: Partial<HelpdeskQuestion> = {}): HelpdeskQuestion {
  return {
    id: '0192bbbb-0000-7000-8000-000000000001',
    locale: 'en-GB',
    category: 'technical_support',
    question: 'How do I reset my password?',
    answer: 'Use "Forgot password" on the sign-in page.',
    keywords: ['password'],
    status: 'draft',
    featured: false,
    sortOrder: 10,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const validInput = {
  locale: 'en-GB',
  category: 'technical_support',
  question: '  Cannot log in  ',
  answer: 'Line one\r\nLine two\n\nVisit https://example.com/help  ',
  keywords: [' Login ', 'login', '', 'password'],
  featured: true,
};

async function rejection(promise: Promise<unknown>): Promise<HelpdeskError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HelpdeskError);
  return error as HelpdeskError;
}

function setup(seed: HelpdeskQuestion[] = [], stats?: HelpdeskSuggestionStats) {
  const repository = createMemoryQuestionRepository(seed);
  const service = createQuestionService({ repository, stats });
  return { repository, service };
}

describe('Common Questions: create', () => {
  it('normalises input, starts as a draft at version 1 and writes one create revision', async () => {
    const { repository, service } = setup([question({ sortOrder: 40 })]);
    const created = await service.create(employee, validInput);
    expect(created).toMatchObject({
      locale: 'en-GB',
      category: 'technical_support',
      question: 'Cannot log in',
      answer: 'Line one\nLine two\n\nVisit https://example.com/help',
      keywords: ['login', 'password'],
      status: 'draft',
      featured: true,
      sortOrder: 50,
      version: 1,
      createdBy: employee.employeeId,
      updatedBy: employee.employeeId,
      stats: { shown: 0, solved: 0, declined: 0 },
    });
    expect(created.id).toMatch(/^[0-9a-f-]{8}-[0-9a-f]{4}-7/);
    expect(repository.revisionRows).toHaveLength(1);
    expect(repository.revisionRows[0]).toMatchObject({
      questionId: created.id,
      version: 1,
      action: 'create',
      employeeId: employee.employeeId,
    });
    expect(repository.revisionRows[0].snapshot).toMatchObject({
      question: 'Cannot log in',
      status: 'draft',
    });
  });

  it('publishes straight away when "publish now" is ticked', async () => {
    const { service } = setup();
    const created = await service.create(employee, {
      ...validInput,
      publish: true,
    });
    expect(created.status).toBe('published');
    expect(created.sortOrder).toBe(10);
  });

  it.each([
    ['locale', { locale: 'fr-FR' }],
    ['category', { category: 'account' }],
    ['empty question', { question: '   ' }],
    ['long question', { question: 'q'.repeat(201) }],
    ['empty answer', { answer: ' ' }],
    ['long answer', { answer: 'a'.repeat(4001) }],
    ['keywords not a list', { keywords: 'login' }],
    [
      'too many keywords',
      { keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) },
    ],
    ['long keyword', { keywords: ['k'.repeat(41)] }],
    ['keyword not text', { keywords: [3] }],
    ['featured not boolean', { featured: 'yes' }],
    ['publish not boolean', { publish: 1 }],
  ])('rejects %s with 400 INVALID_INPUT', async (_name, patch) => {
    const { repository, service } = setup();
    const error = await rejection(
      service.create(employee, { ...validInput, ...patch }),
    );
    expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(repository.rows.size).toBe(0);
  });

  it('accepts exactly 200 / 4000 characters', async () => {
    const { service } = setup();
    await expect(
      service.create(employee, {
        ...validInput,
        question: 'q'.repeat(200),
        answer: 'a'.repeat(4000),
      }),
    ).resolves.toMatchObject({ version: 1 });
  });
});

describe('Common Questions: optimistic version', () => {
  const edit = {
    locale: 'en-GB',
    category: 'course_content',
    question: 'Where are my lessons?',
    answer: 'Open My Learning.',
    keywords: ['lessons'],
    featured: false,
  };

  it('updates when the version matches, bumps it and writes an update revision', async () => {
    const { repository, service } = setup([question({ version: 3 })]);
    const updated = await service.update(employee, question().id, {
      ...edit,
      version: 3,
    });
    expect(updated).toMatchObject({
      category: 'course_content',
      question: 'Where are my lessons?',
      version: 4,
      updatedBy: employee.employeeId,
    });
    expect(repository.revisionRows).toEqual([
      expect.objectContaining({ version: 4, action: 'update' }),
    ]);
  });

  it('answers 409 VERSION_CONFLICT on a stale version and changes nothing', async () => {
    const { repository, service } = setup([question({ version: 3 })]);
    const error = await rejection(
      service.update(employee, question().id, { ...edit, version: 2 }),
    );
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(repository.rows.get(question().id)?.question).toBe(
      'How do I reset my password?',
    );
    expect(repository.revisionRows).toHaveLength(0);
  });

  it('requires a whole-number version and a UUID id', async () => {
    const { service } = setup([question()]);
    for (const version of [undefined, '1', 1.5, -1]) {
      const error = await rejection(
        service.update(employee, question().id, { ...edit, version }),
      );
      expect(error.code).toBe('INVALID_INPUT');
    }
    const error = await rejection(
      service.update(employee, '../x', { ...edit, version: 1 }),
    );
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('answers 404 QUESTION_NOT_FOUND for an unknown id', async () => {
    const { service } = setup();
    const error = await rejection(
      service.update(employee, question().id, { ...edit, version: 1 }),
    );
    expect(error).toMatchObject({ status: 404, code: 'QUESTION_NOT_FOUND' });
  });

  it('does not edit an archived question', async () => {
    const { service } = setup([question({ status: 'archived' })]);
    const error = await rejection(
      service.update(employee, question().id, { ...edit, version: 1 }),
    );
    expect(error).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });
});

describe('Common Questions: publish / unpublish / archive', () => {
  it.each([
    ['publish', 'draft', 'published'],
    ['publish', 'archived', 'published'],
    ['unpublish', 'published', 'draft'],
    ['archive', 'draft', 'archived'],
    ['archive', 'published', 'archived'],
  ] as const)(
    '%s moves %s to %s with a matching revision',
    async (action, from, to) => {
      const { repository, service } = setup([question({ status: from })]);
      const result = await service.transition(employee, question().id, action, {
        version: 1,
      });
      expect(result).toMatchObject({ status: to, version: 2 });
      expect(repository.revisionRows).toEqual([
        expect.objectContaining({ action, version: 2 }),
      ]);
    },
  );

  it.each([
    ['publish', 'published'],
    ['unpublish', 'draft'],
    ['unpublish', 'archived'],
    ['archive', 'archived'],
  ] as const)(
    'refuses %s from %s with 409 INVALID_TRANSITION',
    async (action, from) => {
      const { repository, service } = setup([question({ status: from })]);
      const error = await rejection(
        service.transition(employee, question().id, action, { version: 1 }),
      );
      expect(error).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
      expect(repository.revisionRows).toHaveLength(0);
    },
  );

  it('checks the version before the state', async () => {
    const { service } = setup([question({ status: 'published', version: 5 })]);
    const error = await rejection(
      service.transition(employee, question().id, 'publish', { version: 4 }),
    );
    expect(error.code).toBe('VERSION_CONFLICT');
  });
});

describe('Common Questions: sort order', () => {
  const a = question({
    id: '0192bbbb-0000-7000-8000-00000000000a',
    sortOrder: 10,
  });
  const b = question({
    id: '0192bbbb-0000-7000-8000-00000000000b',
    sortOrder: 20,
  });
  const c = question({
    id: '0192bbbb-0000-7000-8000-00000000000c',
    sortOrder: 30,
  });

  it('renumbers in the given order, bumping only rows that moved', async () => {
    const { repository, service } = setup([a, b, c]);
    const result = await service.reorder(employee, {
      items: [
        { id: c.id, version: 1 },
        { id: b.id, version: 1 },
        { id: a.id, version: 1 },
      ],
    });
    expect(result.questions.map((q) => [q.id, q.sortOrder, q.version])).toEqual(
      [
        [c.id, 10, 2],
        [b.id, 20, 1],
        [a.id, 30, 2],
      ],
    );
    expect(repository.revisionRows.map((r) => r.action)).toEqual([
      'update',
      'update',
    ]);
  });

  it('is all-or-nothing on a stale version', async () => {
    const { repository, service } = setup([a, b]);
    const error = await rejection(
      service.reorder(employee, {
        items: [
          { id: b.id, version: 1 },
          { id: a.id, version: 9 },
        ],
      }),
    );
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(repository.rows.get(b.id)?.sortOrder).toBe(20);
  });

  it('rejects empty, duplicate or oversized lists', async () => {
    const { service } = setup([a]);
    for (const items of [
      [],
      [
        { id: a.id, version: 1 },
        { id: a.id, version: 1 },
      ],
      Array.from({ length: 501 }, () => ({ id: a.id, version: 1 })),
      'x',
    ]) {
      const error = await rejection(service.reorder(employee, { items }));
      expect(error.code).toBe('INVALID_INPUT');
    }
  });
});

describe('Common Questions: list, counters and revisions', () => {
  const draft = question({
    id: '0192bbbb-0000-7000-8000-000000000011',
    status: 'draft',
  });
  const live = question({
    id: '0192bbbb-0000-7000-8000-000000000012',
    status: 'published',
    category: 'other',
    sortOrder: 5,
  });
  const gone = question({
    id: '0192bbbb-0000-7000-8000-000000000013',
    status: 'archived',
  });
  const chinese = question({
    id: '0192bbbb-0000-7000-8000-000000000014',
    locale: 'zh-CN',
    status: 'published',
  });

  it('hides archived questions unless asked, and filters by locale / category / status', async () => {
    const { service } = setup([draft, live, gone, chinese]);
    const ids = async (query: Record<string, string>) =>
      (await service.list(query)).questions.map((q) => q.id);
    expect(await ids({})).toEqual([live.id, draft.id, chinese.id]);
    expect(await ids({ status: 'all' })).toHaveLength(4);
    expect(await ids({ status: 'archived' })).toEqual([gone.id]);
    expect(await ids({ locale: 'zh-CN' })).toEqual([chinese.id]);
    expect(await ids({ category: 'other' })).toEqual([live.id]);
    for (const query of [
      { locale: 'xx' },
      { category: 'nope' },
      { status: 'deleted' },
      { q: 'x'.repeat(201) },
    ]) {
      const error = await rejection(service.list(query));
      expect(error.code).toBe('INVALID_INPUT');
    }
  });

  it('adds shown / solved / declined counters from the suggestion log', async () => {
    const statsFor = jest
      .fn()
      .mockResolvedValue(
        new Map([[live.id, { shown: 7, solved: 4, declined: 2 }]]),
      );
    const stats: HelpdeskSuggestionStats = { statsFor };
    const { service } = setup([draft, live], stats);
    const { questions } = await service.list({});
    expect(statsFor).toHaveBeenCalledWith([live.id, draft.id]);
    expect(questions.find((q) => q.id === live.id)?.stats).toEqual({
      shown: 7,
      solved: 4,
      declined: 2,
    });
    expect(questions.find((q) => q.id === draft.id)?.stats).toEqual({
      shown: 0,
      solved: 0,
      declined: 0,
    });
  });

  it('still lists questions when the counters cannot be read', async () => {
    const stats: HelpdeskSuggestionStats = {
      statsFor: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const { service } = setup([live], stats);
    const { questions } = await service.list({});
    expect(questions[0].stats).toEqual({ shown: 0, solved: 0, declined: 0 });
  });

  it('returns one question and its revisions newest first', async () => {
    const { service } = setup([draft]);
    await service.transition(employee, draft.id, 'publish', { version: 1 });
    await service.transition(employee, draft.id, 'unpublish', { version: 2 });
    expect((await service.get(draft.id)).version).toBe(3);
    const { revisions } = await service.revisions(draft.id);
    expect(revisions.map((r) => [r.version, r.action])).toEqual([
      [3, 'unpublish'],
      [2, 'publish'],
    ]);
    const error = await rejection(
      service.get('0192bbbb-0000-7000-8000-0000000000ff'),
    );
    expect(error.code).toBe('QUESTION_NOT_FOUND');
  });
});

describe('Common Questions: what Portal reads (published only, ETag)', () => {
  const rows = [
    question({
      id: '0192bbbb-0000-7000-8000-000000000021',
      status: 'published',
      sortOrder: 20,
      featured: true,
    }),
    question({
      id: '0192bbbb-0000-7000-8000-000000000022',
      status: 'published',
      sortOrder: 10,
      featured: false,
    }),
    question({
      id: '0192bbbb-0000-7000-8000-000000000023',
      status: 'draft',
      featured: true,
    }),
    question({
      id: '0192bbbb-0000-7000-8000-000000000024',
      status: 'archived',
      featured: true,
    }),
    question({
      id: '0192bbbb-0000-7000-8000-000000000025',
      status: 'published',
      locale: 'zh-CN',
      featured: true,
    }),
  ];

  it('returns only published questions of the locale, by sort order, in the public shape', async () => {
    const { service } = setup(rows);
    const all = await service.published({ locale: 'en-GB' });
    expect(all.notModified).toBe(false);
    expect(all.body.questions).toEqual([
      {
        id: rows[1].id,
        category: rows[1].category,
        question: rows[1].question,
        answer: rows[1].answer,
      },
      {
        id: rows[0].id,
        category: rows[0].category,
        question: rows[0].question,
        answer: rows[0].answer,
      },
    ]);
    const featured = await service.published({
      locale: 'en-GB',
      featured: 'true',
    });
    expect(featured.body.questions.map((q) => q.id)).toEqual([rows[0].id]);
    expect(featured.body.etag).toBe(featured.etag);
  });

  it('requires a supported locale and a boolean featured flag', async () => {
    const { service } = setup(rows);
    for (const query of [
      {},
      { locale: 'fr' },
      { locale: 'en-GB', featured: 'maybe' },
    ]) {
      const error = await rejection(service.published(query));
      expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
  });

  it('gives a stable strong ETag that changes when published content changes', async () => {
    const { service } = setup(rows);
    const first = await service.published({ locale: 'en-GB' });
    const again = await service.published({ locale: 'en-GB' });
    expect(first.etag).toMatch(/^"[A-Za-z0-9_-]{16,}"$/);
    expect(again.etag).toBe(first.etag);
    await service.update(employee, rows[0].id, {
      locale: 'en-GB',
      category: rows[0].category,
      question: 'Changed?',
      answer: rows[0].answer,
      keywords: [],
      featured: true,
      version: 1,
    });
    const changed = await service.published({ locale: 'en-GB' });
    expect(changed.etag).not.toBe(first.etag);
    expect(publishedEtag([])).not.toBe(first.etag);
  });

  it('answers not-modified for a matching If-None-Match (list, weak or *)', async () => {
    const { service } = setup(rows);
    const { etag } = await service.published({ locale: 'en-GB' });
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const result = await service.published({ locale: 'en-GB' }, header);
      expect(result.notModified).toBe(true);
      expect(result.etag).toBe(etag);
    }
    const miss = await service.published({ locale: 'en-GB' }, '"stale"');
    expect(miss.notModified).toBe(false);
  });
});
