import type { SessionEmployee } from '../contracts/employee';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import {
  createFaqService,
  publishedEtag,
} from '../modules/helpdesk/faqs/faqService';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import { createMemoryFaqRepository } from './helpers/memoryFaqRepository';

/**
 * Tickets v2 §1 / §2 / §3：FAQ 数据层。Admin 是唯一写入方；一条 FAQ 中英双语；保存即发布；
 * 每次修改带 version（不一致 409 VERSION_CONFLICT），修订行与修改同一次写入；删除 = 归档；
 * Portal 只读已发布的（按语言挑字段，ETag）。
 */
const employee = {
  employeeId: '0192aaaa-0000-7000-8000-000000000001',
  displayName: 'alice',
} as SessionEmployee;

let counter = 0;
function faq(overrides: Partial<HelpdeskFaq> = {}): HelpdeskFaq {
  counter += 1;
  return {
    id: `0192bbbb-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    key: `faq-${counter}`,
    type: 'answer',
    entry: true,
    category: 'account_technical',
    popular: false,
    questionEn: 'How do I reset my password?',
    answerEn: 'Use **Forgot password** on the sign-in page.',
    questionZh: '如何重置密码？',
    answerZh: '在登录页点击“忘记密码”。',
    keywords: ['password'],
    signals: [],
    status: 'published',
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const validInput = {
  category: 'account_technical',
  popular: true,
  questionEn: '  Cannot log in  ',
  answerEn:
    'Line one\r\nLine two\n\n1. Open **Settings**\n2. See [help](https://example.com/help)  ',
  questionZh: ' 无法登录 ',
  answerZh: '- 打开设置\n- 联系 [客服](mailto:support@example.com)',
  keywords: [' Login ', 'login', '', 'Password'],
};

async function rejection(promise: Promise<unknown>): Promise<HelpdeskError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HelpdeskError);
  return error as HelpdeskError;
}

function setup(seed: HelpdeskFaq[] = []) {
  const repository = createMemoryFaqRepository(seed);
  const service = createFaqService({ repository });
  return { repository, service };
}

describe('FAQs: create (saving publishes)', () => {
  it('normalises input, publishes at version 1 and writes one create revision', async () => {
    const { repository, service } = setup();
    const created = await service.create(employee, validInput);
    expect(created).toMatchObject({
      category: 'account_technical',
      popular: true,
      questionEn: 'Cannot log in',
      answerEn:
        'Line one\nLine two\n\n1. Open **Settings**\n2. See [help](https://example.com/help)',
      questionZh: '无法登录',
      answerZh: '- 打开设置\n- 联系 [客服](mailto:support@example.com)',
      keywords: ['login', 'password'],
      status: 'published',
      version: 1,
      createdBy: employee.employeeId,
      updatedBy: employee.employeeId,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{8}-[0-9a-f]{4}-7/);
    expect(repository.revisionRows).toHaveLength(1);
    expect(repository.revisionRows[0]).toMatchObject({
      action: 'create',
      version: 1,
    });
  });

  it('creates once per Idempotency-Key and refuses the key with a different FAQ', async () => {
    const { repository, service } = setup();
    const key = '0192dddd-0000-4000-8000-000000000001';
    const first = await service.create(employee, validInput, key);
    const retry = await service.create(employee, validInput, key);
    expect(retry.id).toBe(first.id);
    expect(repository.rows.size).toBe(1);
    expect(repository.revisionRows).toHaveLength(1);
    const reused = await rejection(
      service.create(employee, { ...validInput, questionEn: 'Other' }, key),
    );
    expect(reused).toMatchObject({
      status: 422,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(
      await rejection(service.create(employee, validInput, 'not-a-uuid')),
    ).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  });

  it('requires every field of both languages, with a known category', async () => {
    const { service } = setup();
    for (const missing of [
      'category',
      'questionEn',
      'answerEn',
      'questionZh',
      'answerZh',
    ]) {
      const body: Record<string, unknown> = { ...validInput };
      delete body[missing];
      expect(await rejection(service.create(employee, body))).toMatchObject({
        status: 400,
        code: 'INVALID_INPUT',
      });
    }
    for (const bad of [
      { category: 'technical_support' },
      { questionEn: '   ' },
      { popular: 'yes' },
      { keywords: 'login' },
      { keywords: [1] },
    ]) {
      expect(
        await rejection(service.create(employee, { ...validInput, ...bad })),
      ).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
  });

  it('enforces the size limits: questions 200, answers 4000, 20 keywords of 40', async () => {
    const { service } = setup();
    await expect(
      service.create(employee, {
        ...validInput,
        questionEn: 'q'.repeat(200),
        questionZh: '问'.repeat(200),
        answerEn: 'a'.repeat(4000),
        answerZh: '答'.repeat(4000),
        keywords: Array.from({ length: 20 }, (_, i) => `k${i}`.padEnd(40, 'x')),
      }),
    ).resolves.toMatchObject({ version: 1 });
    for (const bad of [
      { questionEn: 'q'.repeat(201) },
      { questionZh: '问'.repeat(201) },
      { answerEn: 'a'.repeat(4001) },
      { answerZh: '答'.repeat(4001) },
      { keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) },
      { keywords: ['k'.repeat(41)] },
    ]) {
      expect(
        await rejection(service.create(employee, { ...validInput, ...bad })),
      ).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
  });

  it('only allows http(s) and mailto links in answers, and refuses control characters', async () => {
    const { service } = setup();
    for (const answerEn of [
      '[click](javascript:alert(1))',
      '[x](data:text/html,hi)',
      '[x](//evil.example)',
      '[x](ftp://example.com)',
      'NUL \u0000 here',
    ]) {
      expect(
        await rejection(service.create(employee, { ...validInput, answerEn })),
      ).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
    await expect(
      service.create(employee, {
        ...validInput,
        answerEn: 'Tabs\tand [a](HTTPS://example.com) [b](mailto:a@b.co)',
      }),
    ).resolves.toMatchObject({ version: 1 });
  });
});

describe('FAQs: edit with an optimistic version', () => {
  it('updates when the version matches, bumps it and writes an update revision', async () => {
    const existing = faq();
    const { repository, service } = setup([existing]);
    const updated = await service.update(employee, existing.id, {
      ...validInput,
      version: 1,
    });
    expect(updated).toMatchObject({
      questionEn: 'Cannot log in',
      version: 2,
      updatedBy: employee.employeeId,
    });
    expect(repository.revisionRows.map((r) => r.action)).toEqual(['update']);
  });

  it('answers 409 VERSION_CONFLICT on a stale version and changes nothing', async () => {
    const existing = faq({ version: 3 });
    const { repository, service } = setup([existing]);
    const error = await rejection(
      service.update(employee, existing.id, { ...validInput, version: 2 }),
    );
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(repository.rows.get(existing.id)?.questionEn).toBe(
      existing.questionEn,
    );
    expect(repository.revisionRows).toHaveLength(0);
  });

  it('is idempotent (RFC 9110 PUT): a retry of a save whose response was lost returns the FAQ, not a conflict', async () => {
    const existing = faq();
    const { repository, service } = setup([existing]);
    const first = await service.update(employee, existing.id, {
      ...validInput,
      version: 1,
    });
    expect(first.version).toBe(2);
    // 同一份内容、同一个旧 version 再发一次：状态已经是这样了
    const retry = await service.update(employee, existing.id, {
      ...validInput,
      version: 1,
    });
    expect(retry).toEqual(first);
    // 什么都没改的保存也不升版本、不写修订（不改变 Portal 读到的 ETag）
    const same = await service.update(employee, existing.id, {
      ...validInput,
      version: 2,
    });
    expect(same).toEqual(first);
    expect(repository.revisionRows.map((r) => r.action)).toEqual(['update']);
    // 内容不同的旧 version 仍是冲突
    const error = await rejection(
      service.update(employee, existing.id, {
        ...validInput,
        questionEn: 'Something else',
        version: 1,
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('requires a whole-number version and a UUID id', async () => {
    const existing = faq();
    const { service } = setup([existing]);
    for (const version of [undefined, 0, 1.5, '1']) {
      expect(
        await rejection(
          service.update(employee, existing.id, { ...validInput, version }),
        ),
      ).toMatchObject({ status: 400 });
    }
    expect(
      await rejection(
        service.update(employee, 'nope', { ...validInput, version: 1 }),
      ),
    ).toMatchObject({ status: 400 });
  });

  it('answers 404 FAQ_NOT_FOUND for an unknown or deleted FAQ', async () => {
    const gone = faq({ status: 'archived' });
    const { service } = setup([gone]);
    for (const id of [gone.id, '0192bbbb-0000-7000-8000-ffffffffffff']) {
      expect(
        await rejection(
          service.update(employee, id, { ...validInput, version: 1 }),
        ),
      ).toMatchObject({ status: 404, code: 'FAQ_NOT_FOUND' });
      expect(await rejection(service.get(id))).toMatchObject({
        status: 404,
        code: 'FAQ_NOT_FOUND',
      });
    }
  });
});

describe('FAQs: delete (archive)', () => {
  it('archives with the version and writes an archive revision; the FAQ leaves every list', async () => {
    const existing = faq();
    const { repository, service } = setup([existing]);
    const archived = await service.archive(employee, existing.id, {
      version: 1,
    });
    expect(archived).toMatchObject({ status: 'archived', version: 2 });
    expect(repository.revisionRows.map((r) => r.action)).toEqual(['archive']);
    expect((await service.list({})).faqs).toEqual([]);
    expect((await service.published({ locale: 'en-GB' })).body.faqs).toEqual(
      [],
    );
  });

  it('is idempotent: deleting an already deleted FAQ succeeds without another revision', async () => {
    const existing = faq();
    const { repository, service } = setup([existing]);
    await service.archive(employee, existing.id, { version: 1 });
    await expect(
      service.archive(employee, existing.id, { version: 1 }),
    ).resolves.toMatchObject({ status: 'archived', version: 2 });
    expect(repository.revisionRows).toHaveLength(1);
  });

  it('checks the version of a live FAQ', async () => {
    const existing = faq({ version: 4 });
    const { service } = setup([existing]);
    expect(
      await rejection(service.archive(employee, existing.id, { version: 3 })),
    ).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });
});

describe('FAQs: the BackOffice table (filters, paging, revisions)', () => {
  function seeded() {
    return [
      faq({
        questionEn: 'Where is my invoice?',
        category: 'payments_subscriptions',
        popular: true,
        updatedAt: '2026-10-28T00:00:00.000Z',
      }),
      faq({
        questionEn: 'Join a live session',
        updatedAt: '2026-10-22T00:00:00.000Z',
      }),
      faq({ status: 'archived', updatedAt: '2026-10-29T00:00:00.000Z' }),
      ...Array.from({ length: 10 }, (_, i) =>
        faq({
          questionEn: `Filler ${i}`,
          updatedAt: `2026-09-${String(10 + i)}T00:00:00.000Z`,
        }),
      ),
    ];
  }

  it('pages 10 rows at a time, newest first, with the total of published FAQs', async () => {
    const { service } = setup(seeded());
    const first = await service.list({});
    expect(first).toMatchObject({ total: 12, page: 1, pageSize: 10 });
    expect(first.faqs).toHaveLength(10);
    expect(first.faqs[0].questionEn).toBe('Where is my invoice?');
    const second = await service.list({ page: '2' });
    expect(second.faqs).toHaveLength(2);
    expect(second.page).toBe(2);
  });

  it('filters by category, popular and search text', async () => {
    const { service } = setup(seeded());
    expect(
      (await service.list({ category: 'payments_subscriptions' })).total,
    ).toBe(1);
    expect((await service.list({ popular: 'true' })).total).toBe(1);
    expect((await service.list({ popular: 'false' })).total).toBe(11);
    expect(
      (await service.list({ q: '  INVOICE ' })).faqs.map((f) => f.questionEn),
    ).toEqual(['Where is my invoice?']);
  });

  it('answers 400 (not 500) for repeated, non-text or unknown list parameters', async () => {
    const { service } = setup();
    for (const bad of [
      { q: ['a', 'b'] },
      { category: 'technical_support' },
      { popular: 'yes' },
      { page: '0' },
      { page: 'x' },
      { pageSize: '51' },
      { q: 'x'.repeat(201) },
    ]) {
      expect(await rejection(service.list(bad))).toMatchObject({
        status: 400,
        code: 'INVALID_INPUT',
      });
    }
  });

  it('returns one FAQ and its revisions newest first', async () => {
    const existing = faq();
    const { service } = setup([existing]);
    await service.update(employee, existing.id, { ...validInput, version: 1 });
    expect((await service.get(existing.id)).version).toBe(2);
    expect(
      (await service.revisions(existing.id)).revisions.map((r) => r.version),
    ).toEqual([2]);
  });
});

describe('FAQs: what Portal reads (§2, published only, by locale, ETag)', () => {
  function seeded() {
    return [
      faq({
        questionEn: 'Reset password',
        questionZh: '重置密码',
        answerZh: '点击忘记密码。',
        updatedAt: '2026-10-20T00:00:00.000Z',
      }),
      faq({
        questionEn: 'Invoice',
        category: 'payments_subscriptions',
        popular: true,
        updatedAt: '2026-10-10T00:00:00.000Z',
      }),
      faq({ status: 'archived', popular: true }),
    ];
  }

  it('picks the fields of the locale and orders popular first, then newest', async () => {
    const { service } = setup(seeded());
    const en = await service.published({ locale: 'en-GB' });
    expect(en.body.faqs.map((f) => f.question)).toEqual([
      'Invoice',
      'Reset password',
    ]);
    expect(Object.keys(en.body.faqs[0]).sort()).toEqual(
      // v5 Part A: signals is part of the public shape (contract fixture v6)
      [
        'answer',
        'category',
        'id',
        'popular',
        'question',
        'signals',
        'updatedAt',
      ].sort(),
    );
    const zh = await service.published({ locale: 'zh-CN' });
    expect(zh.body.faqs[1]).toMatchObject({
      question: '重置密码',
      answer: '点击忘记密码。',
      category: 'account_technical',
      popular: false,
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(zh.body.etag).toBe(zh.etag);
  });

  it('filters popular and category, caps the limit at 100', async () => {
    const { service } = setup(seeded());
    expect(
      (
        await service.published({ locale: 'en-GB', popular: 'true' })
      ).body.faqs.map((f) => f.question),
    ).toEqual(['Invoice']);
    expect(
      (
        await service.published({
          locale: 'en-GB',
          category: 'account_technical',
        })
      ).body.faqs.map((f) => f.question),
    ).toEqual(['Reset password']);
    expect(
      (await service.published({ locale: 'en-GB', limit: '1' })).body.faqs,
    ).toHaveLength(1);
    for (const bad of [
      {},
      { locale: 'fr-FR' },
      { locale: 'en-GB', popular: 'yes' },
      { locale: 'en-GB', category: 'course_content' },
      { locale: 'en-GB', limit: '101' },
      { locale: 'en-GB', limit: '0' },
      { locale: ['en-GB', 'zh-CN'] },
    ]) {
      expect(await rejection(service.published(bad))).toMatchObject({
        status: 400,
      });
    }
  });

  it('searches with q through the suggest retrieval in that locale, keeping the filters', async () => {
    const { repository, service } = setup(seeded());
    const result = await service.published({
      locale: 'zh-CN',
      q: ' 密码 ',
      category: 'account_technical',
      popular: 'false',
      limit: '5',
    });
    expect(result.body.faqs.map((f) => f.question)).toEqual(['重置密码']);
    expect(repository.searches).toEqual([
      {
        locale: 'zh-CN',
        boost: null,
        text: '密码',
        limit: 5,
        category: 'account_technical',
        popular: false,
      },
    ]);
  });

  it('gives a stable strong ETag that changes when published content changes', async () => {
    const rows = seeded();
    const { service } = setup(rows);
    const a = await service.published({ locale: 'en-GB' });
    const b = await service.published({ locale: 'en-GB' });
    expect(a.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(b.etag).toBe(a.etag);
    await service.update(employee, rows[0].id, { ...validInput, version: 1 });
    expect((await service.published({ locale: 'en-GB' })).etag).not.toBe(
      a.etag,
    );
    expect(publishedEtag([])).toBe(publishedEtag([]));
  });

  it('answers not-modified for a matching If-None-Match (list, weak or *)', async () => {
    const { service } = setup(seeded());
    const { etag } = await service.published({ locale: 'en-GB' });
    for (const header of [etag, `W/${etag}`, `"x", ${etag}`, '*']) {
      expect(
        (await service.published({ locale: 'en-GB' }, header)).notModified,
      ).toBe(true);
    }
    expect(
      (await service.published({ locale: 'en-GB' }, '"other"')).notModified,
    ).toBe(false);
  });

  it('returns one published FAQ in a locale, or 404 for unknown, deleted or malformed ids', async () => {
    const rows = seeded();
    const { service } = setup(rows);
    await expect(
      service.publishedOne(rows[0].id, { locale: 'zh-CN' }),
    ).resolves.toMatchObject({ id: rows[0].id, question: '重置密码' });
    for (const id of [
      rows[2].id,
      '0192bbbb-0000-7000-8000-ffffffffffff',
      'x',
    ]) {
      expect(
        await rejection(service.publishedOne(id, { locale: 'en-GB' })),
      ).toMatchObject({ status: 404, code: 'FAQ_NOT_FOUND' });
    }
    expect(
      await rejection(service.publishedOne(rows[0].id, { locale: 'de' })),
    ).toMatchObject({ status: 400 });
  });
});

describe('FAQs: situation signals (v5 Part A)', () => {
  it('stores the signals staff pick, deduped in the chip priority order, and Portal reads them', async () => {
    const { service } = setup();
    const created = await service.create(employee, {
      ...validInput,
      signals: ['recent_purchase', 'payment_failed', 'recent_purchase'],
    });
    expect(created.signals).toEqual(['payment_failed', 'recent_purchase']);
    const read = await service.published({ locale: 'en-GB' });
    expect(read.body.faqs[0].signals).toEqual([
      'payment_failed',
      'recent_purchase',
    ]);
    await expect(
      service.publishedOne(created.id, { locale: 'zh-CN' }),
    ).resolves.toMatchObject({
      signals: ['payment_failed', 'recent_purchase'],
    });
  });

  it('defaults to none, and a save without signals (an older BackOffice) keeps the stored ones', async () => {
    const { service } = setup();
    const plain = await service.create(employee, validInput);
    expect(plain.signals).toEqual([]);
    const tagged = await service.create(employee, {
      ...validInput,
      questionEn: 'Payment failed',
      signals: ['payment_failed'],
    });
    const saved = await service.update(employee, tagged.id, {
      ...validInput,
      questionEn: 'Payment failed',
      answerEn: 'Try another card.',
      version: tagged.version,
    });
    expect(saved.signals).toEqual(['payment_failed']);
    expect(saved.version).toBe(2);
    const cleared = await service.update(employee, tagged.id, {
      ...validInput,
      questionEn: 'Payment failed',
      answerEn: 'Try another card.',
      signals: [],
      version: saved.version,
    });
    expect(cleared.signals).toEqual([]);
    expect(cleared.version).toBe(3);
  });

  it('a signals-only change is a real change (new version), the same signals again are not', async () => {
    const { service } = setup();
    const created = await service.create(employee, validInput);
    const tagged = await service.update(employee, created.id, {
      ...validInput,
      signals: ['email_unverified'],
      version: 1,
    });
    expect(tagged.version).toBe(2);
    const again = await service.update(employee, created.id, {
      ...validInput,
      signals: ['email_unverified'],
      version: 1,
    });
    expect(again.version).toBe(2);
  });

  it('refuses unknown signals, open_ticket_waiting (not an FAQ) and a non-list with 400', async () => {
    const { service } = setup();
    for (const signals of [
      ['payment_failed', 'nope'],
      ['open_ticket_waiting'],
      'payment_failed',
      [1],
    ]) {
      expect(
        await rejection(service.create(employee, { ...validInput, signals })),
      ).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
  });
});

describe('FAQs: v5 question-tree node fields (graph design §2.1)', () => {
  it('creates with a key derived from the English question, as an answer entry, unless given', async () => {
    const { service } = setup();
    const derived = await service.create(employee, validInput);
    expect(derived).toMatchObject({
      key: 'cannot-log-in',
      type: 'answer',
      entry: true,
    });
    const given = await service.create(employee, {
      ...validInput,
      key: ' Login.Help ',
      type: 'choice',
      entry: false,
      answerEn: 'Which one is it?',
      answerZh: '是哪一种？',
    });
    expect(given).toMatchObject({
      key: 'login.help',
      type: 'choice',
      entry: false,
    });
    expect(
      await rejection(
        service.create(employee, { ...validInput, key: 'login.help' }),
      ),
    ).toMatchObject({ status: 409, code: 'FAQ_KEY_TAKEN' });
    for (const bad of [
      { key: 'no spaces' },
      { type: 'quiz' },
      { entry: 'yes' },
    ])
      expect(
        await rejection(service.create(employee, { ...validInput, ...bad })),
      ).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  });

  it('keeps the node fields when an old BackOffice saves without them; a change to them alone bumps the version', async () => {
    const { service } = setup();
    const created = await service.create(employee, {
      ...validInput,
      key: 'k1',
      entry: false,
    });
    const same = await service.update(employee, created.id, {
      ...validInput,
      version: 1,
    });
    expect(same).toMatchObject({ version: 1, key: 'k1', entry: false });
    const moved = await service.update(employee, created.id, {
      ...validInput,
      entry: true,
      version: 1,
    });
    expect(moved).toMatchObject({ version: 2, key: 'k1', entry: true });
  });

  it('a choice prompt has no digits or links', async () => {
    const { service } = setup();
    expect(
      await rejection(
        service.create(employee, {
          ...validInput,
          type: 'choice',
          answerEn: 'Is it order 42?',
          answerZh: '是哪一种？',
        }),
      ),
    ).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  });

  it('refuses to archive a node that live parents still use, naming them', async () => {
    const repository = createMemoryFaqRepository();
    const parents = jest.fn(() =>
      Promise.resolve([
        {
          id: 'p',
          key: 'payment-failed',
          questionEn: 'Payment failed?',
          questionZh: '付款失败？',
        },
      ]),
    );
    const service = createFaqService({ repository, liveParents: parents });
    const created = await service.create(employee, validInput);
    const error = await rejection(
      service.archive(employee, created.id, { version: 1 }),
    );
    expect(error).toMatchObject({ status: 409, code: 'FAQ_HAS_PARENTS' });
    expect(error.message).toContain('"Payment failed?" (payment-failed)');
    expect(repository.rows.get(created.id)?.status).toBe('published');
    parents.mockImplementation(() => Promise.resolve([]));
    expect(
      (await service.archive(employee, created.id, { version: 1 })).status,
    ).toBe('archived');
  });

  it('once a release exists, Portal reads that release (single switch); a choice node is not an article', async () => {
    const repository = createMemoryFaqRepository();
    let version: number | null = null;
    const service = createFaqService({
      repository,
      releaseVersion: () => Promise.resolve(version),
    });
    const prompt = await service.create(employee, {
      ...validInput,
      type: 'choice',
      answerEn: 'Which one is it?',
      answerZh: '是哪一种？',
    });
    await service.published({ locale: 'en-GB', q: 'log' });
    expect(repository.searches.at(-1)).not.toHaveProperty('release');
    version = 4;
    await service.published({ locale: 'en-GB', q: 'log' });
    expect(repository.searches.at(-1)).toMatchObject({ release: 4 });
    expect(
      await rejection(service.publishedOne(prompt.id, { locale: 'en-GB' })),
    ).toMatchObject({ status: 404 });
    // the default list and search leave choice nodes out
    expect((await service.published({ locale: 'en-GB' })).body.faqs).toEqual(
      [],
    );
  });
});
