import type {
  HelpdeskQaCandidate,
  HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';
import {
  directPick,
  openRouterReranker,
  RERANK_LIMITS,
  rerankConfig,
  rerankedSource,
} from './rerank';

const card = (
  n: number,
  extra: Partial<HelpdeskQaCandidate> = {},
): HelpdeskQaCandidate => ({
  id: `0192dddd-0000-7000-8000-${String(n).padStart(12, '0')}`,
  category: 'account_technical',
  question: `Question ${n}`,
  answer: `Answer ${n}`,
  score: 10 - n,
  type: 'answer',
  ...extra,
});

const KEY = 'test-openrouter-key-local-only';

describe('rerankConfig (read each call; off unless a model and a key are set)', () => {
  it('is off without a model or without a key', () => {
    expect(rerankConfig({ OPENROUTER_API_KEY: KEY })).toBeNull();
    expect(
      rerankConfig({ HELPDESK_RERANK_MODEL: 'voyageai/rerank-2.5-lite' }),
    ).toBeNull();
  });

  it('reads model, keep and the direct thresholds; bad values mean "not set"', () => {
    expect(
      rerankConfig({
        OPENROUTER_API_KEY: KEY,
        HELPDESK_RERANK_MODEL: ' voyageai/rerank-2.5-lite ',
        HELPDESK_RERANK_KEEP: '5',
        HELPDESK_RERANK_DIRECT: '0.83, 0.05',
      }),
    ).toEqual({
      model: 'voyageai/rerank-2.5-lite',
      keep: 5,
      direct: { score: 0.83, margin: 0.05 },
    });
    for (const [keep, direct] of [
      ['0', '1.5,0.1'],
      ['x', '0.8'],
      ['2.5', ''],
    ])
      expect(
        rerankConfig({
          OPENROUTER_API_KEY: KEY,
          HELPDESK_RERANK_MODEL: 'm',
          HELPDESK_RERANK_KEEP: keep,
          HELPDESK_RERANK_DIRECT: direct,
        }),
      ).toEqual({ model: 'm', keep: null, direct: null });
  });
});

describe('openRouterReranker (POST {baseUrl}/rerank)', () => {
  const reply = (body: unknown, status = 200) =>
    jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    );

  it('sends the model, the clipped query and the documents with the key, and returns scores in document order', async () => {
    const fetch = reply({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.2 },
      ],
    });
    const rerank = openRouterReranker({
      model: 'voyageai/rerank-2.5-lite',
      apiKey: KEY,
      baseUrl: 'http://llm.test/api/v1/',
      fetch,
    });
    const long = 'q'.repeat(RERANK_LIMITS.queryChars + 50);
    await expect(rerank(long, ['a', 'b'])).resolves.toEqual([0.2, 0.9]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://llm.test/api/v1/rerank');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'voyageai/rerank-2.5-lite',
      query: 'q'.repeat(RERANK_LIMITS.queryChars),
      documents: ['a', 'b'],
    });
  });

  it.each([
    ['an HTTP error', reply({ error: { code: 404 } }, 404)],
    ['a missing score', reply({ results: [{ index: 0, relevance_score: 1 }] })],
    [
      'an index out of range',
      reply({
        results: [
          { index: 0, relevance_score: 1 },
          { index: 5, relevance_score: 1 },
        ],
      }),
    ],
    ['a network failure', jest.fn(() => Promise.reject(new Error('reset')))],
  ])(
    'returns null on %s (caller keeps the retrieval order)',
    async (_, fetch) => {
      const rerank = openRouterReranker({
        model: 'm',
        apiKey: KEY,
        baseUrl: 'http://llm.test/api/v1',
        fetch: fetch,
      });
      await expect(rerank('q', ['a', 'b'])).resolves.toBeNull();
    },
  );
});

describe('rerankedSource (only findCandidates changes)', () => {
  const found = [card(1), card(2), card(3)];
  const qa: HelpdeskQaSource = {
    findCandidates: () => Promise.resolve(found),
    findPublished: () => Promise.resolve(null),
    findPopular: () => Promise.resolve([]),
  };
  const search = { locale: 'en-GB', category: null, text: 'reset', limit: 10 };

  it('orders by rerank score (ties keep retrieval order), adds rerankScore and keeps at most keep cards', async () => {
    const rerank = jest.fn(() => Promise.resolve([0.1, 0.7, 0.7]));
    const ranked = rerankedSource(qa, rerank, 2);
    const out = await ranked.findCandidates(search);
    expect(out.map((c) => [c.id, c.rerankScore])).toEqual([
      [card(2).id, 0.7],
      [card(3).id, 0.7],
    ]);
    expect(rerank).toHaveBeenCalledWith('reset', [
      'Question 1\nAnswer 1',
      'Question 2\nAnswer 2',
      'Question 3\nAnswer 3',
    ]);
  });

  it('returns the retrieval result unchanged when the reranker fails', async () => {
    const ranked = rerankedSource(qa, () => Promise.resolve(null), 1);
    await expect(ranked.findCandidates(search)).resolves.toBe(found);
  });
});

describe('directPick (give the top card without the model only when the reranker is sure)', () => {
  const direct = { score: 0.8, margin: 0.1 };
  it('picks the top answer card above the score with enough lead', () => {
    const top = card(1, { rerankScore: 0.9 });
    expect(directPick([top, card(2, { rerankScore: 0.7 })], direct)).toBe(top);
    expect(directPick([top], direct)).toBe(top);
  });

  it.each([
    ['no thresholds', [card(1, { rerankScore: 0.99 })], null],
    ['no rerank score', [card(1)], direct],
    ['score below', [card(1, { rerankScore: 0.79 })], direct],
    [
      'lead too small',
      [card(1, { rerankScore: 0.9 }), card(2, { rerankScore: 0.85 })],
      direct,
    ],
    [
      'a choice card on top',
      [card(1, { rerankScore: 0.95, type: 'choice' })],
      direct,
    ],
    ['no candidates', [], direct],
  ] as const)('returns null with %s', (_, list, thresholds) => {
    expect(directPick([...list], thresholds)).toBeNull();
  });
});
