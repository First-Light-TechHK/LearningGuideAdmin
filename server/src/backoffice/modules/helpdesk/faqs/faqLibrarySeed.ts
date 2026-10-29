import { createHash } from 'node:crypto';

import {
  isFaqCategory,
  isFaqSignal,
  type FaqCategory,
  type FaqNodeType,
  type FaqSignal,
} from '../../../../contracts/helpdesk-qa';
import { HelpdeskError } from '../portalHelpdeskClient';
import {
  FAQ_KEY_PATTERN,
  PHRASING_LOCALES,
  type FaqActor,
  type HelpdeskFaq,
  type PhrasingLocale,
} from './faqContracts';
import type { FaqGraphService } from './faqGraphService';
import { faqKeySlug } from './faqKeys';
import type { FaqReleaseService } from './faqReleaseService';
import type { FaqRepository } from './faqRepository';
import type { FaqService } from './faqService';
import { toSimplified } from './faqSearchText';

/**
 * 从 FAQ 库文件导入（helpdesk-v5-faq-graph-design §8.2）：经正常的服务层（同样的校验、修订与审计），
 * 按 key 幂等 —— 再跑一次只改有变化的，不会重复建。然后建发布版本 v1（工作表没变就不新建），
 * 检查与评测门过了就发布。
 *
 * 库文件的形状（宽松读，v1 与 v2 都认；不认识的字段忽略）：
 * - 顶层：{ faqs: [...] } 或数组；
 * - 每条：category、popular、questionEn、answerEn、questionZh、answerZh、keywords（同 BackOffice）；
 *   可选 key（缺省 = 英文问题的 slug，与迁移回填同一规则）、type / nodeType（answer | choice；
 *   有 options 就是 choice）、entry（缺省：顶层是入口；有 parentKey 或写在别人 followUps / options
 *   里的不是）、signals（不认识的忽略并报告）、phrasings（字符串数组按文字判断语言，
 *   或 { locale, text } 数组，或 { "en-GB": [...], "zh-CN": [...], "zh-TW": [...] }）、
 *   source（"existing:<id>"：按 id 找到旧行，把它的 key 改成库里的 key）；
 * - 问题链：parentKey（字符串或数组：这条是谁的追问 / 选项），或 followUps / options（数组：
 *   子节点的 key，或 { key, labelEn, labelZh } 引用，或整条子 FAQ 内联）。边的类型由父节点类型决定。
 * 不删除库里没有的东西（只加不减）；已归档的同 key 行跳过并报告。
 */

type Raw = Record<string, unknown>;

export type LibraryPhrasing = { locale: PhrasingLocale; text: string };

export type LibraryNode = {
  key: string;
  type: FaqNodeType;
  entry: boolean;
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  answerEn: string;
  questionZh: string;
  answerZh: string;
  keywords: string[];
  /** undefined = 库里没写（已有的行保留原值）。 */
  signals: FaqSignal[] | undefined;
  phrasings: LibraryPhrasing[];
  /** source "existing:<id>"。 */
  existingId: string | null;
};

export type LibraryEdge = {
  parentKey: string;
  childKey: string;
  labelEn: string | null;
  labelZh: string | null;
};

export type ParsedLibrary = {
  nodes: LibraryNode[];
  edges: LibraryEdge[];
  warnings: string[];
};

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const HAN = /\p{Script=Han}/u;

/** 没写语言的问法：有汉字 → 繁体（与简体不同）是 zh-TW，否则 zh-CN；没有汉字 → en-GB。 */
function guessLocale(text: string): PhrasingLocale {
  if (!HAN.test(text)) return 'en-GB';
  return toSimplified(text) === text ? 'zh-CN' : 'zh-TW';
}

function phrasingsOf(
  raw: unknown,
  warnings: string[],
  key: string,
): LibraryPhrasing[] {
  const out: LibraryPhrasing[] = [];
  const add = (locale: unknown, text: unknown) => {
    const value = str(text);
    if (!value) return;
    const picked =
      locale === undefined
        ? guessLocale(value)
        : (PHRASING_LOCALES as readonly unknown[]).includes(locale)
          ? (locale as PhrasingLocale)
          : null;
    if (!picked) {
      warnings.push(
        `${key}: phrasing with unknown locale ${String(locale)} skipped`,
      );
      return;
    }
    out.push({ locale: picked, text: value.trim() });
  };
  if (Array.isArray(raw)) {
    for (const item of raw)
      if (typeof item === 'string') add(undefined, item);
      else if (isRecord(item)) add(item.locale, item.text);
  } else if (isRecord(raw)) {
    for (const [locale, list] of Object.entries(raw)) {
      const named =
        locale === 'en' ? 'en-GB' : locale === 'zh' ? 'zh-CN' : locale;
      if (Array.isArray(list)) for (const text of list) add(named, text);
    }
  }
  return out;
}

/** 库文件 → 节点与边（纯函数；结构错误直接抛出，内容由服务层校验）。 */
export function parseFaqLibrary(raw: unknown): ParsedLibrary {
  const top = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.faqs)
      ? raw.faqs
      : null;
  if (!top) throw new Error('The library must be a list or { faqs: [...] }');
  const warnings: string[] = [];
  const nodes = new Map<string, LibraryNode>();
  const edges: LibraryEdge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (edge: LibraryEdge) => {
    const id = `${edge.parentKey}>${edge.childKey}`;
    if (edgeSeen.has(id)) return;
    edgeSeen.add(id);
    edges.push(edge);
  };

  const visit = (item: unknown, inline: boolean, where: string): string => {
    if (!isRecord(item))
      throw new Error(`${where}: each FAQ must be an object`);
    const questionEn = str(item.questionEn);
    if (!questionEn) throw new Error(`${where}: questionEn is required`);
    const key = (str(item.key) ?? faqKeySlug(questionEn)).trim().toLowerCase();
    if (!FAQ_KEY_PATTERN.test(key))
      throw new Error(`${where}: invalid key ${key}`);
    if (!isFaqCategory(item.category))
      throw new Error(`${where} (${key}): unknown category`);
    const options = Array.isArray(item.options) ? item.options : [];
    const followUps = Array.isArray(item.followUps) ? item.followUps : [];
    const rawType = item.type ?? item.nodeType;
    const type: FaqNodeType =
      rawType === 'choice' || (rawType === undefined && options.length > 0)
        ? 'choice'
        : 'answer';
    const parentKeys = (
      Array.isArray(item.parentKey) ? item.parentKey : [item.parentKey]
    )
      .map(str)
      .filter((value): value is string => value !== null)
      .map((value) => value.toLowerCase());
    let signals: FaqSignal[] | undefined;
    if (Array.isArray(item.signals)) {
      signals = [];
      for (const signal of item.signals)
        if (isFaqSignal(signal)) signals.push(signal);
        else warnings.push(`${key}: unknown signal ${String(signal)} skipped`);
    }
    const source = str(item.source);
    const existing = source?.match(/^existing:([0-9a-f-]{36})$/i);
    const node: LibraryNode = {
      key,
      type,
      entry:
        typeof item.entry === 'boolean'
          ? item.entry
          : !inline && parentKeys.length === 0,
      category: item.category,
      popular: item.popular === true,
      questionEn,
      answerEn: typeof item.answerEn === 'string' ? item.answerEn : '',
      questionZh: typeof item.questionZh === 'string' ? item.questionZh : '',
      answerZh: typeof item.answerZh === 'string' ? item.answerZh : '',
      keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
      signals,
      phrasings: phrasingsOf(item.phrasings, warnings, key),
      existingId: existing ? existing[1].toLowerCase() : null,
    };
    const before = nodes.get(key);
    if (before) {
      if (JSON.stringify(before) !== JSON.stringify(node))
        throw new Error(`${where}: key ${key} is used by two different FAQs`);
    } else nodes.set(key, node);

    for (const parentKey of parentKeys)
      addEdge({
        parentKey,
        childKey: key,
        labelEn: str(item.labelEn),
        labelZh: str(item.labelZh),
      });
    const children = type === 'choice' ? options : followUps;
    if (type === 'answer' && options.length > 0)
      warnings.push(`${key}: options on an answer ignored`);
    if (type === 'choice' && followUps.length > 0)
      warnings.push(`${key}: followUps on a choice ignored`);
    children.forEach((child, index) => {
      const at = `${where} > ${key}.${type === 'choice' ? 'options' : 'followUps'}[${index}]`;
      if (typeof child === 'string') {
        addEdge({
          parentKey: key,
          childKey: child.trim().toLowerCase(),
          labelEn: null,
          labelZh: null,
        });
        return;
      }
      if (!isRecord(child))
        throw new Error(`${at}: must be a key or an object`);
      const childKey =
        str(child.questionEn) !== null
          ? visit(child, true, at)
          : (str(child.key) ?? str(child.childKey))?.toLowerCase();
      if (!childKey) throw new Error(`${at}: needs a key or a whole FAQ`);
      addEdge({
        parentKey: key,
        childKey,
        labelEn: str(child.labelEn) ?? str(child.label),
        labelZh: str(child.labelZh),
      });
    });
    return key;
  };

  top.forEach((item, index) => visit(item, false, `faqs[${index}]`));
  for (const edge of edges)
    for (const end of [edge.parentKey, edge.childKey])
      if (!nodes.has(end))
        throw new Error(
          `Link ${edge.parentKey} → ${edge.childKey}: no FAQ with key ${end}`,
        );
  return { nodes: [...nodes.values()], edges, warnings };
}

/** key → 确定的 Idempotency-Key（UUID 形状的 SHA-256 前 16 字节）：中途失败重跑也只建一条。 */
export function seedIdempotencyKey(key: string): string {
  const hex = createHash('sha256')
    .update(`helpdesk-faq-seed:${key}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type SeedReport = {
  nodes: {
    created: string[];
    updated: string[];
    unchanged: number;
    skipped: { key: string; reason: string }[];
  };
  edges: {
    created: number;
    existing: number;
    relabelled: number;
    failed: { link: string; reason: string }[];
  };
  phrasings: {
    created: number;
    existing: number;
    failed: { key: string; reason: string }[];
  };
  release: {
    version: number;
    status: string;
    created: boolean;
    published: boolean;
  } | null;
  warnings: string[];
};

export type SeedDeps = {
  faqs: FaqService;
  repository: Pick<FaqRepository, 'getByKey' | 'get'>;
  graph: FaqGraphService;
  releases?: FaqReleaseService;
};

function reason(error: unknown): string {
  return error instanceof HelpdeskError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

export async function seedFaqLibrary(
  deps: SeedDeps,
  library: ParsedLibrary,
  options: { actor: FaqActor; release: boolean },
): Promise<SeedReport> {
  const report: SeedReport = {
    nodes: { created: [], updated: [], unchanged: 0, skipped: [] },
    edges: { created: 0, existing: 0, relabelled: 0, failed: [] },
    phrasings: { created: 0, existing: 0, failed: [] },
    release: null,
    warnings: [...library.warnings],
  };
  const ids = new Map<string, string>();

  for (const node of library.nodes) {
    let current: HelpdeskFaq | null = await deps.repository.getByKey(node.key);
    if (!current && node.existingId) {
      const old = await deps.repository.get(node.existingId);
      if (old) current = old;
    }
    if (current && current.status !== 'published') {
      report.nodes.skipped.push({ key: node.key, reason: 'archived' });
      continue;
    }
    const body = {
      key: node.key,
      type: node.type,
      entry: node.entry,
      category: node.category,
      popular: node.popular,
      questionEn: node.questionEn,
      answerEn: node.answerEn,
      questionZh: node.questionZh,
      answerZh: node.answerZh,
      keywords: node.keywords,
      ...(node.signals === undefined ? {} : { signals: node.signals }),
    };
    try {
      if (current) {
        const saved = await deps.faqs.update(options.actor, current.id, {
          ...body,
          version: current.version,
        });
        ids.set(node.key, saved.id);
        if (saved.version === current.version) report.nodes.unchanged += 1;
        else report.nodes.updated.push(node.key);
      } else {
        const saved = await deps.faqs.create(
          options.actor,
          body,
          seedIdempotencyKey(node.key),
        );
        ids.set(node.key, saved.id);
        report.nodes.created.push(node.key);
      }
    } catch (error) {
      report.nodes.skipped.push({ key: node.key, reason: reason(error) });
    }
  }

  for (const edge of library.edges) {
    const link = `${edge.parentKey} → ${edge.childKey}`;
    const parentId = ids.get(edge.parentKey);
    const childId = ids.get(edge.childKey);
    if (!parentId || !childId) {
      report.edges.failed.push({ link, reason: 'an end was skipped' });
      continue;
    }
    const labels =
      edge.labelEn !== null && edge.labelZh !== null
        ? { labelEn: edge.labelEn, labelZh: edge.labelZh }
        : {};
    try {
      const { created } = await deps.graph.createEdge(options.actor, parentId, {
        childId,
        ...labels,
      });
      if (created) report.edges.created += 1;
      else report.edges.existing += 1;
    } catch (error) {
      if (error instanceof HelpdeskError && error.code === 'FAQ_EDGE_EXISTS') {
        const { children } = await deps.graph.edges(parentId);
        const found = children.find((view) => view.edge.childId === childId);
        if (found) {
          await deps.graph.updateEdge(options.actor, found.edge.id, {
            labelEn: edge.labelEn,
            labelZh: edge.labelZh,
          });
          report.edges.relabelled += 1;
          continue;
        }
      }
      report.edges.failed.push({ link, reason: reason(error) });
    }
  }

  for (const node of library.nodes) {
    const id = ids.get(node.key);
    if (!id) continue;
    for (const phrasing of node.phrasings) {
      try {
        const { created } = await deps.graph.addPhrasing(
          options.actor,
          id,
          phrasing,
          'seed',
        );
        if (created) report.phrasings.created += 1;
        else report.phrasings.existing += 1;
      } catch (error) {
        report.phrasings.failed.push({ key: node.key, reason: reason(error) });
      }
    }
  }

  if (options.release && deps.releases) {
    const { release, created } = await deps.releases.create(options.actor);
    let published = release.status === 'published';
    let final = release;
    if (!published && release.publishable) {
      final = await deps.releases.publish(options.actor, release.version);
      published = true;
    }
    report.release = {
      version: final.version,
      status: final.status,
      created,
      published,
    };
  }
  return report;
}
