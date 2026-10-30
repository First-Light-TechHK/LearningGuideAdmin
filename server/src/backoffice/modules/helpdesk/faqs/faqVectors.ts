import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import type { FaqNodeType } from '../../../../contracts/helpdesk-qa';
import { query, withTransaction } from '../../../lib/db';
import { FAQ_LIMITS, type HelpdeskFaq } from './faqContracts';
import type { FaqRepository, FaqSearch, SqlDb } from './faqRepository';

/**
 * FAQ 检索的向量层（RAG 基建，owner 2026-10-30 22:07Z：先把基建打好，人工过一遍卡片后再决定上不上）。
 *
 * 默认什么都不做：HELPDESK_RETRIEVAL 缺省 / 不认识 = lexical（只用现有的字词检索）；没有 HELPDESK_EMBED_MODEL
 * 或 OPENROUTER_API_KEY 就没有向量模型，发布时不算向量、检索时不调模型。两个都是每次现读（不用重新部署）。
 * - 发布版本的每个节点：英文问题、中文问题、每条学员问法（原文）各算一个向量；向量按 (模型, 文本哈希) 存一份，
 *   文本没变就不再算，所以以后新增或改了卡片，发布时只算改动的那几条（helpdesk_faq_embeddings）；
 *   某一版用到哪些文本记在 helpdesk_faq_release_vectors（迁移 20261031110000）。
 * - 不用 pgvector（CI 的 postgres:16 没有这个扩展）：向量存 REAL[]，按 (版本, 模型) 整批读进内存，单位化后点积；
 *   几千条文本，一次查询毫秒级。卡片多到上万再换 pgvector + HNSW，接口不变。
 * - 检索：vector = 只按向量排；hybrid = 字词与向量两路各自排好，再用 RRF（Reciprocal Rank Fusion）合并。
 *   向量这一路失败、超时或这一版还没算好 → 退回字词检索，学员不会因为它拿不到候选。
 * - 节点的向量分数 = 它所有文本里和问题最像的那一条（问法多的卡不会因为多而吃亏或占便宜）。
 */

export type RetrievalMode = 'lexical' | 'vector' | 'hybrid';

export const FAQ_VECTOR_LIMITS = {
  /** 每次请求至多这么多条文本（OpenRouter 的 embeddings 接口一次收一个数组）。 */
  batchMax: 64,
  /** 一个节点至多用这么多条问法（库里每条 FAQ 至多 30 条问法，FAQ_LIMITS.phrasingsMax）。 */
  phrasingsPerNode: FAQ_LIMITS.phrasingsMax,
  /** 学员的问题至多取这么多字算向量（和 v5 推荐给模型看的长度同一量级）。 */
  queryCharsMax: 600,
  /** 检索时等向量这一路至多这么久，过了就只用字词检索。 */
  queryTimeoutMs: 1_200,
  /** 发布后算一整版向量的期限（650 张卡约 6,000 条文本，100 次请求）。 */
  indexTimeoutMs: 120_000,
  /** 学员问题的向量缓存条数（同一句话再问不再调模型）。 */
  queryCacheMax: 500,
  /** 某一版还没有向量时，隔这么久再去库里看一次。 */
  emptyRecheckMs: 60_000,
  /** RRF 的常数 k（文献里的常用值）。 */
  rrfK: 60,
} as const;

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const defaultDb: SqlDb = {
  query: (sql, params) => query(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

const logger = new Logger('HelpdeskFaqVectors');

/** HELPDESK_RETRIEVAL：lexical（缺省）/ vector / hybrid；别的值一律当 lexical。 */
export function retrievalMode(env: NodeJS.ProcessEnv): RetrievalMode {
  const value = env.HELPDESK_RETRIEVAL?.trim().toLowerCase();
  return value === 'vector' || value === 'hybrid' ? value : 'lexical';
}

/* ---------------------------------- 文本 ---------------------------------- */

export type FaqVectorSource = 'question_en' | 'question_zh' | 'phrasing';
export type FaqVectorText = { source: FaqVectorSource; text: string };

/** 空白合成一个空格、去掉首尾；比较重复时再忽略大小写。 */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 一个节点要算向量的文本：英文问题、中文问题、问法（按给的顺序，至多 phrasingsPerNode 条）；去重、去空。 */
export function faqVectorTexts(node: {
  questionEn: string;
  questionZh: string;
  phrasings: readonly string[];
}): FaqVectorText[] {
  const out: FaqVectorText[] = [];
  const seen = new Set<string>();
  const add = (source: FaqVectorSource, raw: string) => {
    const text = clean(raw);
    const same = text.toLowerCase();
    if (text === '' || seen.has(same)) return;
    seen.add(same);
    out.push({ source, text });
  };
  add('question_en', node.questionEn);
  add('question_zh', node.questionZh);
  node.phrasings
    .slice(0, FAQ_VECTOR_LIMITS.phrasingsPerNode)
    .forEach((text) => add('phrasing', text));
  return out;
}

/** 文本的 sha256（十六进制）；同一模型下同一文本只存一个向量。 */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ---------------------------------- 模型 ---------------------------------- */

export type FaqEmbedder = {
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * OpenRouter 的 embeddings 接口（OpenAI 兼容：POST {base}/embeddings，{ model, input }）。
 * 没有 HELPDESK_EMBED_MODEL 或 OPENROUTER_API_KEY → null（不算向量，也不检索向量）。
 */
export function openRouterFaqEmbedder(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = fetch,
): FaqEmbedder | null {
  const model = env.HELPDESK_EMBED_MODEL?.trim() ?? '';
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? '';
  if (model === '' || apiKey === '') return null;
  const baseUrl = (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  return {
    model,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: texts }),
        signal,
      });
      if (!response.ok) throw new Error(`embeddings: HTTP ${response.status}`);
      const body = (await response.json()) as {
        data?: { index?: number; embedding?: unknown }[];
      };
      const rows = [...(body.data ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      if (rows.length !== texts.length)
        throw new Error(
          `embeddings: asked for ${texts.length}, got ${rows.length}`,
        );
      const vectors = rows.map((row) => row.embedding);
      const dims = Array.isArray(vectors[0]) ? vectors[0].length : 0;
      for (const vector of vectors)
        if (
          !Array.isArray(vector) ||
          vector.length === 0 ||
          vector.length !== dims ||
          !vector.every((x) => typeof x === 'number' && Number.isFinite(x))
        )
          throw new Error('embeddings: malformed vector');
      return vectors as number[][];
    },
  };
}

/* ---------------------------------- 存储 ---------------------------------- */

export type FaqVectorNode = {
  id: string;
  questionEn: string;
  questionZh: string;
  phrasings: string[];
};

/** 节点在发布版本里的过滤字段（向量命中后先在内存里按检索条件过滤，不逐条查库）。 */
export type FaqVectorNodeMeta = {
  type: FaqNodeType;
  entry: boolean;
  category: string;
  popular: boolean;
};

export type FaqVectorStore = {
  /** 某一版的全部节点与它们的问法（问法取快照里的原文）。 */
  releaseNodes(release: number): Promise<FaqVectorNode[]>;
  /** 这些哈希里，这个模型还没有向量的。 */
  missing(model: string, hashes: readonly string[]): Promise<string[]>;
  save(
    model: string,
    rows: readonly { hash: string; text: string; vector: readonly number[] }[],
  ): Promise<void>;
  link(
    release: number,
    model: string,
    rows: readonly { nodeId: string; hash: string; source: FaqVectorSource }[],
  ): Promise<void>;
  /** 某一版、某个模型的全部向量（每行一条文本，带节点的过滤字段）；还没算 → 空数组。 */
  load(
    release: number,
    model: string,
  ): Promise<({ nodeId: string; vector: number[] } & FaqVectorNodeMeta)[]>;
};

export function createPgFaqVectorStore(db: SqlDb = defaultDb): FaqVectorStore {
  return {
    async releaseNodes(release) {
      const nodes = await db.query(
        `SELECT id, question_en, question_zh FROM helpdesk_faq_release_nodes
          WHERE release_version = $1 ORDER BY id`,
        [release],
      );
      const phrasings = await db.query(
        `SELECT p->>'faqId' AS faq_id, p->>'text' AS text
           FROM helpdesk_faq_releases r,
                jsonb_array_elements(COALESCE(r.snapshot->'phrasings', '[]'::jsonb)) WITH ORDINALITY AS t(p, n)
          WHERE r.version = $1
          ORDER BY t.n`,
        [release],
      );
      const byNode = new Map<string, string[]>();
      for (const row of phrasings) {
        const id = String(row.faq_id).toLowerCase();
        const list = byNode.get(id) ?? [];
        list.push(typeof row.text === 'string' ? row.text : '');
        byNode.set(id, list);
      }
      return nodes.map((row) => {
        const id = String(row.id);
        return {
          id,
          questionEn: String(row.question_en),
          questionZh: String(row.question_zh),
          phrasings: byNode.get(id) ?? [],
        };
      });
    },

    async missing(model, hashes) {
      if (hashes.length === 0) return [];
      const rows = await db.query(
        `SELECT h FROM unnest($2::text[]) AS h
          WHERE NOT EXISTS (SELECT 1 FROM helpdesk_faq_embeddings e
                             WHERE e.model = $1 AND e.text_hash = h)`,
        [model, [...hashes]],
      );
      return rows.map((row) => String(row.h));
    },

    async save(model, rows) {
      if (rows.length === 0) return;
      await db.query(
        `INSERT INTO helpdesk_faq_embeddings (model, text_hash, text, dims, embedding)
         SELECT $1, r.hash, r.text, cardinality(r.vector), r.vector
           FROM jsonb_to_recordset($2::jsonb) AS r(hash text, text text, vector real[])
         ON CONFLICT (model, text_hash) DO NOTHING`,
        [
          model,
          JSON.stringify(
            rows.map((row) => ({
              hash: row.hash,
              text: row.text,
              vector: `{${row.vector.join(',')}}`,
            })),
          ),
        ],
      );
    },

    async link(release, model, rows) {
      if (rows.length === 0) return;
      await db.query(
        `INSERT INTO helpdesk_faq_release_vectors (release_version, node_id, model, text_hash, source)
         SELECT $1, r.node_id::uuid, $2, r.hash, r.source
           FROM jsonb_to_recordset($3::jsonb) AS r(node_id text, hash text, source text)
         ON CONFLICT DO NOTHING`,
        [
          release,
          model,
          JSON.stringify(
            rows.map((row) => ({
              node_id: row.nodeId,
              hash: row.hash,
              source: row.source,
            })),
          ),
        ],
      );
    },

    async load(release, model) {
      const rows = await db.query(
        `SELECT v.node_id, e.embedding, n.node_type, n.entry, n.category, n.popular
           FROM helpdesk_faq_release_vectors v
           JOIN helpdesk_faq_embeddings e
             ON e.model = v.model AND e.text_hash = v.text_hash
           JOIN helpdesk_faq_release_nodes n
             ON n.release_version = v.release_version AND n.id = v.node_id
          WHERE v.release_version = $1 AND v.model = $2`,
        [release, model],
      );
      return rows.map((row) => ({
        nodeId: String(row.node_id),
        vector: (row.embedding as unknown[]).map(Number),
        type: row.node_type as FaqNodeType,
        entry: Boolean(row.entry),
        category: String(row.category),
        popular: Boolean(row.popular),
      }));
    },
  };
}

/* ---------------------------------- 建索引 ---------------------------------- */

export type FaqVectorIndexReport = {
  release: number;
  model: string;
  nodes: number;
  texts: number;
  /** 这次新算的文本条数（其余用库里已有的向量）。 */
  embedded: number;
};

/**
 * 给一个发布版本算向量（幂等）：只算库里还没有的文本，再把这一版的节点和文本连起来。
 * 连接在最后一次写完，读的一方要么看到完整的一版，要么一条也看不到（退回字词检索）。
 */
export async function indexFaqRelease(input: {
  store: FaqVectorStore;
  embedder: FaqEmbedder;
  release: number;
  signal?: AbortSignal;
}): Promise<FaqVectorIndexReport> {
  const { store, embedder, release } = input;
  const nodes = await store.releaseNodes(release);
  const links: { nodeId: string; hash: string; source: FaqVectorSource }[] = [];
  const textOf = new Map<string, string>();
  for (const node of nodes)
    for (const item of faqVectorTexts(node)) {
      const hash = textHash(item.text);
      textOf.set(hash, item.text);
      links.push({ nodeId: node.id, hash, source: item.source });
    }
  const missing = await store.missing(embedder.model, [...textOf.keys()]);
  for (let i = 0; i < missing.length; i += FAQ_VECTOR_LIMITS.batchMax) {
    input.signal?.throwIfAborted();
    const hashes = missing.slice(i, i + FAQ_VECTOR_LIMITS.batchMax);
    const texts = hashes.map((hash) => textOf.get(hash) as string);
    const vectors = await embedder.embed(texts, input.signal);
    await store.save(
      embedder.model,
      hashes.map((hash, j) => ({ hash, text: texts[j], vector: vectors[j] })),
    );
  }
  await store.link(release, embedder.model, links);
  return {
    release,
    model: embedder.model,
    nodes: nodes.length,
    texts: textOf.size,
    embedded: missing.length,
  };
}

/* ---------------------------------- 检索 ---------------------------------- */

/** 单位化（模长 1）；全零向量原样返回（和谁的点积都是 0）。 */
function unit(vector: readonly number[]): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export type FaqVectorHit = {
  id: string;
  similarity: number;
} & FaqVectorNodeMeta;

export type FaqVectorSearch = {
  /** 这一版全部节点按和问题的相似度从高到低；没有模型、这一版还没算好、调用失败 → null。 */
  rank(
    release: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<FaqVectorHit[] | null>;
};

export function createFaqVectorSearch(deps: {
  store: FaqVectorStore;
  embedder: () => FaqEmbedder | null;
  now?: () => number;
}): FaqVectorSearch {
  const now = deps.now ?? (() => Date.now());
  type Loaded = {
    nodes: ({ id: string; vectors: Float32Array[] } & FaqVectorNodeMeta)[];
    at: number;
  };
  const indexes = new Map<string, Promise<Loaded>>();
  const queries = new Map<string, Float32Array>();

  async function index(release: number, model: string): Promise<Loaded> {
    const key = `${release}\n${model}`;
    const cached = indexes.get(key);
    if (cached) {
      const loaded = await cached;
      // 空的（这一版还没算好）隔一会儿再看；算好了的一直用（发布版本不会再变）
      if (
        loaded.nodes.length > 0 ||
        now() - loaded.at < FAQ_VECTOR_LIMITS.emptyRecheckMs
      )
        return loaded;
    }
    const loading = deps.store.load(release, model).then((rows) => {
      const byNode = new Map<string, Loaded['nodes'][number]>();
      for (const row of rows) {
        const node = byNode.get(row.nodeId) ?? {
          id: row.nodeId,
          vectors: [],
          type: row.type,
          entry: row.entry,
          category: row.category,
          popular: row.popular,
        };
        node.vectors.push(unit(row.vector));
        byNode.set(row.nodeId, node);
      }
      return { nodes: [...byNode.values()], at: now() };
    });
    indexes.set(key, loading);
    loading.catch(() => indexes.delete(key));
    return loading;
  }

  async function queryVector(
    embedder: FaqEmbedder,
    text: string,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    const key = `${embedder.model}\n${text}`;
    const cached = queries.get(key);
    if (cached) return cached;
    const [vector] = await embedder.embed([text], signal);
    const value = unit(vector);
    if (queries.size >= FAQ_VECTOR_LIMITS.queryCacheMax)
      queries.delete(queries.keys().next().value as string);
    queries.set(key, value);
    return value;
  }

  return {
    async rank(release, raw, signal) {
      const embedder = deps.embedder();
      const text = clean(raw).slice(0, FAQ_VECTOR_LIMITS.queryCharsMax);
      if (!embedder || text === '') return null;
      const loaded = await index(release, embedder.model);
      if (loaded.nodes.length === 0) return null;
      const query = await queryVector(embedder, text, signal);
      return loaded.nodes
        .map(({ vectors, ...node }) => ({
          ...node,
          similarity: Math.max(...vectors.map((v) => dot(query, v))),
        }))
        .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1));
    },
  };
}

/** RRF：每一路里排第 r 名（从 1 起）得 1 / (k + r)，各路相加。 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k: number = FAQ_VECTOR_LIMITS.rrfK,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((id, index) =>
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1)),
    );
  return fused;
}

/**
 * 包一层检索仓库：searchPublished 按模式走字词 / 向量 / 混合，其余方法原样。
 * 只对发布版本生效（向量按版本算）；第一版发布之前、lexical、没有模型、向量失败或超时 → 原来的字词检索。
 * 向量命中、字词没命中的节点按 id 读出来，过滤条件和字词检索一样（入口、节点类型、分类、热门）。
 * 分数：hybrid / vector 时是 RRF 分（只用来排序；放大 1000 倍免得全是很小的小数）。
 */
export function withFaqVectorSearch(
  base: FaqRepository,
  deps: {
    vectors: FaqVectorSearch;
    mode: () => RetrievalMode;
    timeoutMs?: number;
    onError?: (error: unknown) => void;
  },
): FaqRepository {
  const timeoutMs = deps.timeoutMs ?? FAQ_VECTOR_LIMITS.queryTimeoutMs;

  async function vectorRanking(
    search: FaqSearch,
  ): Promise<FaqVectorHit[] | null> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      // 先定下结果（null）再取消，取消时才回来的结果不会被用上
      timer = setTimeout(() => {
        resolve(null);
        controller.abort();
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        deps.vectors.rank(
          search.release as number,
          search.text,
          controller.signal,
        ),
        timedOut,
      ]);
    } catch (error) {
      deps.onError?.(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 和字词检索同样的过滤：入口、节点类型、分类、热门（发布版本里的节点都是 published）。 */
  function keeps(hit: FaqVectorNodeMeta, search: FaqSearch): boolean {
    if ((search.entryOnly ?? true) && !hit.entry) return false;
    if (!(search.types ?? ['answer']).includes(hit.type)) return false;
    if (search.category !== undefined && hit.category !== search.category)
      return false;
    if (search.popular !== undefined && hit.popular !== search.popular)
      return false;
    return true;
  }

  return {
    ...base,
    async searchPublished(search) {
      const mode = deps.mode();
      const release = search.release ?? null;
      if (mode === 'lexical' || release === null || search.text.trim() === '')
        return base.searchPublished(search);
      const limit = Math.min(
        Math.max(1, Math.floor(search.limit)),
        FAQ_LIMITS.publicLimitMax,
      );
      const [lexical, ranked] = await Promise.all([
        base.searchPublished(search),
        vectorRanking(search),
      ]);
      if (!ranked) return lexical;
      const byId = new Map<string, HelpdeskFaq>(
        lexical.map((faq) => [faq.id, faq]),
      );
      // 向量这一路：按相似度取前 limit 个符合过滤条件的节点
      const vectorIds = ranked
        .filter((hit) => keeps(hit, search))
        .slice(0, limit)
        .map((hit) => hit.id);
      const fused = [
        ...reciprocalRankFusion(
          mode === 'vector'
            ? [vectorIds]
            : [lexical.map((faq) => faq.id), vectorIds],
        ),
      ]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit);
      // 只有向量命中、字词没命中的节点才按 id 读一次（并行）
      await Promise.all(
        fused
          .filter(([id]) => !byId.has(id))
          .map(async ([id]) => {
            const row = await base.getPublished(id, { release });
            if (row) byId.set(id, row);
          }),
      );
      return fused.flatMap(([id, score]) => {
        const faq = byId.get(id);
        return faq
          ? [{ ...faq, score: Math.round(score * 1000 * 1e4) / 1e4 }]
          : [];
      });
    },
  };
}

/** 错误只记一行（不带学员文字；模型返回的错误截到 200 字）。 */
export function vectorErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'error';
}

/** 检索时向量这一路失败：记一行警告，这一次退回字词检索。 */
export function logFaqVectorSearchError(error: unknown): void {
  logger.warn(
    `helpdesk faq vectors: search fell back to lexical: ${vectorErrorMessage(error)}`,
  );
}

/** 生产组装：每次现读环境变量的向量检索（没有模型 = 不检索向量）。 */
export function createEnvFaqVectorSearch(
  db: SqlDb = defaultDb,
  env: () => NodeJS.ProcessEnv = () => process.env,
): FaqVectorSearch {
  return createFaqVectorSearch({
    store: createPgFaqVectorStore(db),
    embedder: () => openRouterFaqEmbedder(env()),
  });
}

/**
 * 发布后给新版本算向量（不等它、不影响发布结果）。没有模型 = 什么都不做；失败只记日志，
 * 下一次发布或手动跑 npm run helpdesk:faq-vectors 会补上（幂等）。
 */
export type FaqVectorIndexer = {
  index(release: number): Promise<FaqVectorIndexReport | null>;
};

export function createEnvFaqVectorIndexer(
  db: SqlDb = defaultDb,
  env: () => NodeJS.ProcessEnv = () => process.env,
  log: (message: string) => void = (message) => logger.warn(message),
): FaqVectorIndexer {
  const store = createPgFaqVectorStore(db);
  return {
    async index(release) {
      const embedder = openRouterFaqEmbedder(env());
      if (!embedder) return null;
      try {
        return await indexFaqRelease({
          store,
          embedder,
          release,
          signal: AbortSignal.timeout(FAQ_VECTOR_LIMITS.indexTimeoutMs),
        });
      } catch (error) {
        log(
          `helpdesk faq vectors: release ${release} not indexed: ${vectorErrorMessage(error)}`,
        );
        return null;
      }
    },
  };
}
