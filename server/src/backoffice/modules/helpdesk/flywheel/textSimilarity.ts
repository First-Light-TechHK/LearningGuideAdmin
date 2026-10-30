import { chineseSearchForms } from '../faqs/faqSearchText';

/**
 * 缺口挖掘的「按意思分组」（v5 Part G3 第 2 步）与和已发布 FAQ 的去重（第 4 步）用的相似度。
 *
 * 接口与实现分开：现在的实现是现有检索的同一套文本归一（faqSearchText.ts：OpenCC 繁 → 简、
 * 港台用词与粤语口语 → 普通话；中文双字、英文词），按这一批文本的 IDF 加权，余弦相似度。
 * 以后换成向量（embeddings）只要再写一个 TextSimilarity（embed 异步，就是为它留的），挖掘不用改。
 * 纯代码，不调模型；Portal 的占位符（<email>、<phone> …）不算特征。
 */
export interface TextSimilarity<V = unknown> {
  readonly name: string;
  /** 一批文本 → 向量（同一批里的向量才能互相比较：IDF 按这一批算）。 */
  embed(texts: readonly string[]): Promise<V[]>;
  /** 0..1，对称，同一个文本为 1，空向量为 0。 */
  similarity(a: V, b: V): number;
  /** 一组向量的中心（分组时代表一组）。 */
  centroid(vectors: readonly V[]): V;
}

/** 稀疏向量：特征 → 权重，已归一（模长 1；空向量模长 0）。 */
export type SparseVector = {
  readonly weights: ReadonlyMap<string, number>;
  readonly norm: number;
};

const PLACEHOLDER = /<[a-z_]{2,16}>/g;
const HAN_RUN = /\p{Script=Han}+/gu;
const WORD = /[\p{Script=Latin}\p{N}]+/gu;

/** 只表示语气、几乎句句都有的英文词（IDF 也会压低它们，这里先去掉，短句里才不喧宾夺主）。 */
const EN_STOP = new Set(
  (
    'a an the i me my mine we our you your it its is are was were be been am do does did ' +
    'to of in on at for from by with and or but not no so if then than this that these those ' +
    'can could would should will just please hi hello hey thanks thank ok okay im ive dont ' +
    'cant there here what how why when where which who'
  ).split(' '),
);

/** 单字特征里不算的虚字（双字照算）。 */
const ZH_STOP = new Set([
  ...'的了是我你他她它们在吗呢吧啊呀么着就都也还要会能可这那有个一不',
]);

/** 单字特征的权重（双字与英文词为 1）：意思相近、用字不同的句子靠它拉近，又不压过双字。 */
const CHAR_WEIGHT = 0.5;

/** 很粗的词干：去掉常见词尾（足够让 arrive / arrives / arriving 对上）。 */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  if (word.length > 4 && word.endsWith('e')) return word.slice(0, -1);
  return word;
}

/**
 * 一句话的特征（去重）：中文双字与单字 c:（简体与普通话改写；单字不含虚字）、英文词干 w:。
 */
export function similarityFeatures(text: string): string[] {
  const lower = text.replace(PLACEHOLDER, ' ').normalize('NFKC').toLowerCase();
  const features = new Set<string>();
  for (const form of chineseSearchForms(lower)) {
    for (const run of form.match(HAN_RUN) ?? []) {
      const chars = [...run].filter((char) => !ZH_STOP.has(char));
      for (const char of chars) features.add(`c:${char}`);
      for (let i = 0; i + 1 < chars.length; i++)
        features.add(chars[i] + chars[i + 1]);
    }
  }
  for (const word of lower.match(WORD) ?? []) {
    if (word.length < 2 || EN_STOP.has(word) || /^\d+$/.test(word)) continue;
    features.add(`w:${stem(word)}`);
  }
  return [...features];
}

function normalise(weights: Map<string, number>): SparseVector {
  let sum = 0;
  for (const value of weights.values()) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return { weights: new Map(), norm: 0 };
  const out = new Map<string, number>();
  for (const [key, value] of weights) out.set(key, value / norm);
  return { weights: out, norm: 1 };
}

/** 现有检索的同一套文本归一 + IDF 加权余弦（见文件头）。 */
export function createNgramSimilarity(): TextSimilarity<SparseVector> {
  return {
    name: 'ngram',
    embed(texts) {
      const features = texts.map((text) => similarityFeatures(text));
      const df = new Map<string, number>();
      for (const list of features)
        for (const feature of list) df.set(feature, (df.get(feature) ?? 0) + 1);
      const n = texts.length;
      return Promise.resolve(
        features.map((list) => {
          const weights = new Map<string, number>();
          for (const feature of list)
            weights.set(
              feature,
              Math.log(1 + n / (df.get(feature) ?? 1)) *
                (feature.startsWith('c:') ? CHAR_WEIGHT : 1),
            );
          return normalise(weights);
        }),
      );
    },
    similarity(a, b) {
      if (a.norm === 0 || b.norm === 0) return 0;
      const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
      let dot = 0;
      for (const [key, value] of small.weights) {
        const other = large.weights.get(key);
        if (other !== undefined) dot += value * other;
      }
      return Math.min(1, Math.max(0, dot));
    },
    centroid(vectors) {
      const sum = new Map<string, number>();
      for (const vector of vectors)
        for (const [key, value] of vector.weights)
          sum.set(key, (sum.get(key) ?? 0) + value);
      return normalise(sum);
    },
  };
}
