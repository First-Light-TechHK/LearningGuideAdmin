import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import type {
  FaqRepository,
  FaqSearch,
  ScoredFaq,
} from '../modules/helpdesk/faqs/faqRepository';
import {
  FAQ_VECTOR_LIMITS,
  createFaqVectorSearch,
  faqVectorTexts,
  indexFaqRelease,
  openRouterFaqEmbedder,
  reciprocalRankFusion,
  retrievalMode,
  textHash,
  withFaqVectorSearch,
  type FaqEmbedder,
  type FaqVectorHit,
  type FaqVectorNode,
  type FaqVectorNodeMeta,
  type FaqVectorSearch,
  type FaqVectorStore,
} from '../modules/helpdesk/faqs/faqVectors';

/**
 * FAQ 向量检索的基建（faqVectors.ts）：开关缺省是字词检索、要算向量的文本、OpenRouter 的 embeddings
 * 调用、按文本哈希的增量建索引、按版本缓存的相似度排序、RRF 合并与过滤、失败和超时退回字词检索。
 * PostgreSQL 上的读写见 helpdesk-faq-vectors.pg.spec.ts。
 */

const RELEASE = 3;

function faq(id: string, fields: Partial<HelpdeskFaq> = {}): HelpdeskFaq {
  return {
    id,
    key: id,
    type: 'answer',
    entry: true,
    category: 'other',
    popular: false,
    questionEn: `Question ${id}?`,
    answerEn: 'Answer.',
    questionZh: `问题${id}？`,
    answerZh: '答案。',
    keywords: [],
    signals: [],
    status: 'published',
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...fields,
  };
}

function search(fields: Partial<FaqSearch> = {}): FaqSearch {
  return {
    locale: 'zh-CN',
    boost: null,
    text: '钱扣了两次',
    limit: 10,
    release: RELEASE,
    ...fields,
  };
}

/** 字词检索的假仓库：searchPublished 返回给定的结果，getPublished 按 id 查。 */
function baseRepository(
  lexical: HelpdeskFaq[],
  all: HelpdeskFaq[],
): FaqRepository & { gets: string[]; searches: FaqSearch[] } {
  const gets: string[] = [];
  const searches: FaqSearch[] = [];
  const unused = () => Promise.reject(new Error('not used'));
  return {
    gets,
    searches,
    list: unused,
    get: unused,
    insert: unused,
    update: unused,
    revisions: unused,
    listPublished: unused,
    getByKey: unused,
    searchPublished(input) {
      searches.push(input);
      return Promise.resolve(
        lexical.map((row, index): ScoredFaq => ({ ...row, score: 10 - index })),
      );
    },
    getPublished(id) {
      gets.push(id);
      return Promise.resolve(all.find((row) => row.id === id) ?? null);
    },
  };
}

function hit(
  id: string,
  similarity: number,
  meta: Partial<FaqVectorNodeMeta> = {},
): FaqVectorHit {
  return {
    id,
    similarity,
    type: 'answer',
    entry: true,
    category: 'other',
    popular: false,
    ...meta,
  };
}

function fixedVectors(
  hits: FaqVectorHit[] | null,
): FaqVectorSearch & { calls: number } {
  const search = {
    calls: 0,
    rank() {
      search.calls += 1;
      return Promise.resolve(hits);
    },
  };
  return search;
}

/** 内存里的向量库：节点（含过滤字段）、按 (模型, 哈希) 的向量、按 (版本, 模型) 的连接。 */
function memoryStore(
  nodes: (FaqVectorNode & Partial<FaqVectorNodeMeta>)[],
): FaqVectorStore & {
  embeddings: Map<string, { text: string; vector: number[] }>;
  links: Map<string, { nodeId: string; hash: string }[]>;
} {
  const embeddings = new Map<string, { text: string; vector: number[] }>();
  const links = new Map<string, { nodeId: string; hash: string }[]>();
  return {
    embeddings,
    links,
    releaseNodes: () => Promise.resolve(nodes),
    missing: (model, hashes) =>
      Promise.resolve(
        hashes.filter((hash) => !embeddings.has(`${model}|${hash}`)),
      ),
    save(model, rows) {
      for (const row of rows)
        if (!embeddings.has(`${model}|${row.hash}`))
          embeddings.set(`${model}|${row.hash}`, {
            text: row.text,
            vector: [...row.vector],
          });
      return Promise.resolve();
    },
    link(release, model, rows) {
      const key = `${release}|${model}`;
      const list = links.get(key) ?? [];
      for (const row of rows)
        if (!list.some((x) => x.nodeId === row.nodeId && x.hash === row.hash))
          list.push({ nodeId: row.nodeId, hash: row.hash });
      links.set(key, list);
      return Promise.resolve();
    },
    load(release, model) {
      return Promise.resolve(
        (links.get(`${release}|${model}`) ?? []).map((row) => {
          const node = nodes.find((n) => n.id === row.nodeId);
          return {
            nodeId: row.nodeId,
            vector: embeddings.get(`${model}|${row.hash}`)?.vector ?? [],
            type: node?.type ?? 'answer',
            entry: node?.entry ?? true,
            category: node?.category ?? 'other',
            popular: node?.popular ?? false,
          };
        }),
      );
    },
  };
}

/** 假模型：每段文本映射到给定的向量（没给的落在第三个轴上），记下每次调用。 */
function fakeEmbedder(
  table: Record<string, number[]>,
  model = 'test/embed',
): FaqEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    embed(texts) {
      calls.push([...texts]);
      return Promise.resolve(texts.map((text) => table[text] ?? [0, 0, 1]));
    },
  };
}

describe('HELPDESK_RETRIEVAL', () => {
  it('is lexical unless it says vector or hybrid', () => {
    expect(retrievalMode({})).toBe('lexical');
    expect(retrievalMode({ HELPDESK_RETRIEVAL: ' Hybrid ' })).toBe('hybrid');
    expect(retrievalMode({ HELPDESK_RETRIEVAL: 'vector' })).toBe('vector');
    expect(retrievalMode({ HELPDESK_RETRIEVAL: 'pgvector' })).toBe('lexical');
  });
});

describe('faqVectorTexts', () => {
  it('takes both questions and the phrasings, cleaned, without empty or repeated text', () => {
    expect(
      faqVectorTexts({
        questionEn: '  How do I  get a refund? ',
        questionZh: '如何申请退款？',
        phrasings: [
          'how do i get a REFUND?',
          '',
          '钱扣了两次',
          '  钱扣了两次 ',
        ],
      }),
    ).toEqual([
      { source: 'question_en', text: 'How do I get a refund?' },
      { source: 'question_zh', text: '如何申请退款？' },
      { source: 'phrasing', text: '钱扣了两次' },
    ]);
  });

  it('uses at most the library limit of phrasings per node', () => {
    const phrasings = Array.from({ length: 40 }, (_, i) => `phrasing ${i}`);
    const texts = faqVectorTexts({
      questionEn: 'Q',
      questionZh: '问',
      phrasings,
    });
    expect(texts.filter((t) => t.source === 'phrasing')).toHaveLength(
      FAQ_VECTOR_LIMITS.phrasingsPerNode,
    );
  });

  it('hashes text with sha256', () => {
    expect(textHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('openRouterFaqEmbedder', () => {
  const env = {
    HELPDESK_EMBED_MODEL: 'baai/bge-m3',
    OPENROUTER_API_KEY: 'test-key',
  };

  function fetchReturning(status: number, body: unknown) {
    const calls: {
      url: string;
      init: { headers: Record<string, string>; body: string };
    }[] = [];
    const impl = (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
      });
    };
    return { calls, impl };
  }

  it('is off without a model or a key', () => {
    expect(openRouterFaqEmbedder({ OPENROUTER_API_KEY: 'k' })).toBeNull();
    expect(
      openRouterFaqEmbedder({ HELPDESK_EMBED_MODEL: 'baai/bge-m3' }),
    ).toBeNull();
  });

  it('posts the texts to {base}/embeddings and returns the vectors in input order', async () => {
    const { calls, impl } = fetchReturning(200, {
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
    const embedder = openRouterFaqEmbedder(
      { ...env, OPENROUTER_BASE_URL: 'https://example.test/v1/' },
      impl,
    );
    expect(embedder?.model).toBe('baai/bge-m3');
    expect(await embedder?.embed(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0].url).toBe('https://example.test/v1/embeddings');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: 'baai/bge-m3',
      input: ['a', 'b'],
    });
  });

  it('does not call the model for no texts', async () => {
    const { calls, impl } = fetchReturning(200, { data: [] });
    expect(await openRouterFaqEmbedder(env, impl)?.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('rejects an HTTP error, a missing vector and a malformed one', async () => {
    await expect(
      openRouterFaqEmbedder(env, fetchReturning(429, {}).impl)?.embed(['a']),
    ).rejects.toThrow('HTTP 429');
    await expect(
      openRouterFaqEmbedder(
        env,
        fetchReturning(200, { data: [{ index: 0, embedding: [1] }] }).impl,
      )?.embed(['a', 'b']),
    ).rejects.toThrow('asked for 2, got 1');
    await expect(
      openRouterFaqEmbedder(
        env,
        fetchReturning(200, { data: [{ index: 0, embedding: [1, 'x'] }] }).impl,
      )?.embed(['a']),
    ).rejects.toThrow('malformed');
    await expect(
      openRouterFaqEmbedder(
        env,
        fetchReturning(200, {
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [1] },
          ],
        }).impl,
      )?.embed(['a', 'b']),
    ).rejects.toThrow('malformed');
  });
});

describe('indexFaqRelease', () => {
  const nodes: FaqVectorNode[] = [
    {
      id: 'n1',
      questionEn: 'Refund?',
      questionZh: '退款？',
      phrasings: ['钱扣了两次'],
    },
    {
      id: 'n2',
      questionEn: 'Password?',
      questionZh: '密码？',
      phrasings: ['钱扣了两次'],
    },
  ];

  it('embeds only text the model has no vector for, in batches, and links every node to its texts', async () => {
    const many: FaqVectorNode[] = [
      {
        id: 'big',
        questionEn: 'Q',
        questionZh: '问',
        phrasings: Array.from({ length: 30 }, (_, i) => `p${i}`),
      },
      {
        id: 'big2',
        questionEn: 'Second question',
        questionZh: '问2',
        phrasings: Array.from({ length: 30 }, (_, i) => `q${i}`),
      },
    ];
    const store = memoryStore(many);
    const embedder = fakeEmbedder({});
    const report = await indexFaqRelease({ store, embedder, release: RELEASE });
    expect(report).toEqual({
      release: RELEASE,
      model: 'test/embed',
      nodes: 2,
      texts: 64,
      embedded: 64,
    });
    expect(embedder.calls.map((c) => c.length)).toEqual([64]);
    expect(store.links.get(`${RELEASE}|test/embed`)).toHaveLength(64);

    const again = await indexFaqRelease({
      store,
      embedder,
      release: RELEASE + 1,
    });
    expect(again.embedded).toBe(0);
    expect(embedder.calls).toHaveLength(1);
    expect(store.links.get(`${RELEASE + 1}|test/embed`)).toHaveLength(64);
  });

  it('splits into requests of at most batchMax texts', async () => {
    const store = memoryStore([
      {
        id: 'n',
        questionEn: 'Q',
        questionZh: '问',
        phrasings: Array.from({ length: 30 }, (_, i) => `p${i}`),
      },
      {
        id: 'm',
        questionEn: 'R',
        questionZh: '答',
        phrasings: Array.from({ length: 30 }, (_, i) => `r${i}`),
      },
      { id: 'o', questionEn: 'S', questionZh: '说', phrasings: ['x'] },
    ]);
    const embedder = fakeEmbedder({});
    await indexFaqRelease({ store, embedder, release: RELEASE });
    expect(embedder.calls.map((c) => c.length)).toEqual([
      FAQ_VECTOR_LIMITS.batchMax,
      3,
    ]);
  });

  it('shares one vector between nodes with the same text', async () => {
    const store = memoryStore(nodes);
    const embedder = fakeEmbedder({});
    const report = await indexFaqRelease({ store, embedder, release: RELEASE });
    expect(report.texts).toBe(5);
    expect(
      embedder.calls.flat().filter((t) => t === '钱扣了两次'),
    ).toHaveLength(1);
    expect(store.embeddings.size).toBe(5);
    expect(store.links.get(`${RELEASE}|test/embed`)).toHaveLength(6);
  });

  it('writes no links when the model fails, so the release stays on lexical retrieval', async () => {
    const store = memoryStore(nodes);
    const failing: FaqEmbedder = {
      model: 'test/embed',
      embed: () => Promise.reject(new Error('down')),
    };
    await expect(
      indexFaqRelease({ store, embedder: failing, release: RELEASE }),
    ).rejects.toThrow('down');
    expect(store.links.size).toBe(0);
  });
});

describe('createFaqVectorSearch', () => {
  const table = {
    'Refund?': [1, 0, 0],
    '退款？': [1, 0.1, 0],
    钱扣了两次: [0.9, 0.1, 0],
    'Password?': [0, 1, 0],
    '密码？': [0, 1, 0.1],
    忘记密码: [0, 0.9, 0.1],
  };
  const nodes = [
    {
      id: 'refund',
      questionEn: 'Refund?',
      questionZh: '退款？',
      phrasings: ['钱扣了两次'],
    },
    {
      id: 'password',
      questionEn: 'Password?',
      questionZh: '密码？',
      phrasings: ['忘记密码'],
      entry: false,
    },
  ];

  async function indexed() {
    const store = memoryStore(nodes);
    const embedder = fakeEmbedder(table);
    await indexFaqRelease({ store, embedder, release: RELEASE });
    return { store, embedder };
  }

  it('ranks every node by its closest text and carries the node filter fields', async () => {
    const { store, embedder } = await indexed();
    const vectors = createFaqVectorSearch({ store, embedder: () => embedder });
    const ranked = await vectors.rank(RELEASE, '忘记密码');
    expect(ranked?.map((h) => h.id)).toEqual(['password', 'refund']);
    expect(ranked?.[0].similarity).toBeCloseTo(1, 5);
    expect(ranked?.[0].entry).toBe(false);
  });

  it('embeds a repeated question once', async () => {
    const { store, embedder } = await indexed();
    const vectors = createFaqVectorSearch({ store, embedder: () => embedder });
    const before = embedder.calls.length;
    await vectors.rank(RELEASE, '钱扣了两次');
    await vectors.rank(RELEASE, '  钱扣了两次 ');
    expect(embedder.calls.length - before).toBe(1);
  });

  it('returns null without a model, for empty text and for a release that has no vectors yet', async () => {
    const { store, embedder } = await indexed();
    expect(
      await createFaqVectorSearch({ store, embedder: () => null }).rank(
        RELEASE,
        'x',
      ),
    ).toBeNull();
    const vectors = createFaqVectorSearch({ store, embedder: () => embedder });
    expect(await vectors.rank(RELEASE, '   ')).toBeNull();
    expect(await vectors.rank(RELEASE + 9, 'x')).toBeNull();
  });

  it('looks again for vectors of a release that had none after emptyRecheckMs', async () => {
    const store = memoryStore(nodes);
    const embedder = fakeEmbedder(table);
    let clock = 0;
    const vectors = createFaqVectorSearch({
      store,
      embedder: () => embedder,
      now: () => clock,
    });
    expect(await vectors.rank(RELEASE, '退款')).toBeNull();
    await indexFaqRelease({ store, embedder, release: RELEASE });
    clock = FAQ_VECTOR_LIMITS.emptyRecheckMs - 1;
    expect(await vectors.rank(RELEASE, '退款')).toBeNull();
    clock = FAQ_VECTOR_LIMITS.emptyRecheckMs + 1;
    expect(await vectors.rank(RELEASE, '退款')).not.toBeNull();
  });
});

describe('reciprocalRankFusion', () => {
  it('adds 1 / (k + rank) over the rankings', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b'],
      ['c', 'a'],
    ]);
    expect(fused.get('a')).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused.get('b')).toBeCloseTo(1 / 62, 12);
    expect(fused.get('c')).toBeCloseTo(1 / 61, 12);
  });
});

describe('withFaqVectorSearch', () => {
  const a = faq('a');
  const b = faq('b');
  const c = faq('c');
  const followUp = faq('f', { entry: false });
  const all = [a, b, c, followUp];

  it('leaves the lexical search alone in lexical mode, before the first release and for empty text', async () => {
    const base = baseRepository([a], all);
    const vectors = fixedVectors([hit('c', 0.9)]);
    const repo = withFaqVectorSearch(base, { vectors, mode: () => 'lexical' });
    expect((await repo.searchPublished(search())).map((f) => f.id)).toEqual([
      'a',
    ]);
    const hybrid = withFaqVectorSearch(base, { vectors, mode: () => 'hybrid' });
    await hybrid.searchPublished(search({ release: null }));
    await hybrid.searchPublished(search({ release: undefined }));
    await hybrid.searchPublished(search({ text: '  ' }));
    expect(vectors.calls).toBe(0);
  });

  it('hybrid fuses both rankings with RRF and reads a vector-only node once', async () => {
    const base = baseRepository([a, b], all);
    const repo = withFaqVectorSearch(base, {
      vectors: fixedVectors([hit('c', 0.9), hit('a', 0.8), hit('b', 0.1)]),
      mode: () => 'hybrid',
    });
    const found = await repo.searchPublished(search());
    // a: 1/61 + 1/62, c: 1/61, b: 1/62 + 1/63
    expect(found.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(found[0].score).toBeCloseTo((1 / 61 + 1 / 62) * 1000, 3);
    expect(base.gets).toEqual(['c']);
  });

  it('vector mode ranks by the vectors alone', async () => {
    const base = baseRepository([a, b], all);
    const repo = withFaqVectorSearch(base, {
      vectors: fixedVectors([hit('c', 0.9), hit('a', 0.8), hit('b', 0.1)]),
      mode: () => 'vector',
    });
    expect(
      (await repo.searchPublished(search({ limit: 2 }))).map((f) => f.id),
    ).toEqual(['c', 'a']);
  });

  it('applies the same filters as the lexical search before the limit', async () => {
    const base = baseRepository(
      [],
      [
        followUp,
        faq('choice', { type: 'choice' }),
        faq('paid', { category: 'payments_subscriptions' }),
        faq('hot', { popular: true }),
        c,
      ],
    );
    const ranked = [
      hit('f', 0.99, { entry: false }),
      hit('choice', 0.95, { type: 'choice' }),
      hit('paid', 0.9, { category: 'payments_subscriptions' }),
      hit('hot', 0.85, { popular: true }),
      hit('c', 0.5),
    ];
    const repo = withFaqVectorSearch(base, {
      vectors: fixedVectors(ranked),
      mode: () => 'vector',
    });
    expect(
      (await repo.searchPublished(search({ limit: 1 }))).map((f) => f.id),
    ).toEqual(['paid']);
    expect(
      (
        await repo.searchPublished(
          search({ limit: 5, popular: false, category: 'other' }),
        )
      ).map((f) => f.id),
    ).toEqual(['c']);
    expect(
      (
        await repo.searchPublished(
          search({
            limit: 5,
            entryOnly: false,
            popular: false,
            category: 'other',
          }),
        )
      ).map((f) => f.id),
    ).toEqual(['f', 'c']);
  });

  it('falls back to the lexical results when the vectors fail or are not ready', async () => {
    const errors: unknown[] = [];
    const failing: FaqVectorSearch = {
      rank: () => Promise.reject(new Error('embeddings: HTTP 500')),
    };
    const base = baseRepository([a], all);
    const repo = withFaqVectorSearch(base, {
      vectors: failing,
      mode: () => 'hybrid',
      onError: (e) => errors.push(e),
    });
    expect((await repo.searchPublished(search())).map((f) => f.id)).toEqual([
      'a',
    ]);
    expect(errors).toHaveLength(1);
    const notReady = withFaqVectorSearch(base, {
      vectors: fixedVectors(null),
      mode: () => 'vector',
    });
    expect((await notReady.searchPublished(search())).map((f) => f.id)).toEqual(
      ['a'],
    );
  });

  it('does not wait for the vectors past the timeout', async () => {
    const base = baseRepository([a], all);
    let aborted = false;
    const slow: FaqVectorSearch = {
      rank: (_release, _text, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            resolve([hit('c', 1)]);
          });
        }),
    };
    const repo = withFaqVectorSearch(base, {
      vectors: slow,
      mode: () => 'hybrid',
      timeoutMs: 5,
    });
    expect((await repo.searchPublished(search())).map((f) => f.id)).toEqual([
      'a',
    ]);
    expect(aborted).toBe(true);
  });

  it('reads the mode on every search', async () => {
    let mode: 'lexical' | 'hybrid' = 'lexical';
    const vectors = fixedVectors([hit('c', 0.9)]);
    const repo = withFaqVectorSearch(baseRepository([a], all), {
      vectors,
      mode: () => mode,
    });
    await repo.searchPublished(search());
    mode = 'hybrid';
    expect((await repo.searchPublished(search())).map((f) => f.id)).toEqual([
      'a',
      'c',
    ]);
    expect(vectors.calls).toBe(1);
  });
});
