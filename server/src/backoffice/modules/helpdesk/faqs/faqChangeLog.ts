import type { FaqEdgeRow, HelpdeskFaq } from './faqContracts';
import type { FaqReleaseRow } from './faqGraphRepository';

/**
 * Helpdesk FAQ 修改记录（BackOffice Change Log，Figma 草案 2.6–2.9，用户 2026-10-30 确认）：把四张只追加的表
 * 合成一条时间线，每一行回答「谁、什么时候、改了什么」：
 * - helpdesk_faq_revisions：FAQ 新建 / 修改 / 删除（归档），每版存整条快照，改了什么 = 与上一版逐字段比；
 * - helpdesk_faq_edge_revisions：追问 / 选项的连上、改显示文字、排序、移除（改前 / 改后）；
 * - helpdesk_faq_phrasing_revisions：学员问法的加 / 删；
 * - helpdesk_faq_releases：新建版本、发布、回滚。
 * 「学员是否已看到」：编辑先进工作副本，要等包含它的版本发布；还没有任何发布版本时保存即生效。
 * 这里只有纯函数（仓库读原始行，服务补员工名字），便于单测。
 */

export const FAQ_CHANGE_SUBJECTS = [
  'faq',
  'follow_up',
  'option',
  'phrasing',
  'release',
] as const;
export type FaqChangeSubject = (typeof FAQ_CHANGE_SUBJECTS)[number];

export type FaqChangeAction =
  | 'created'
  | 'edited'
  | 'archived'
  | 'added'
  | 'changed'
  | 'reordered'
  | 'removed'
  | 'version_created'
  | 'published'
  | 'rolled_back';

/** FAQ 逐字段比较的字段（与 HelpdeskFaq 同名；version / 时间 / 执行人不算改动）。 */
export const FAQ_CHANGE_FIELDS = [
  'key',
  'type',
  'entry',
  'category',
  'popular',
  'questionEn',
  'answerEn',
  'questionZh',
  'answerZh',
  'keywords',
  'signals',
  'status',
] as const;

/** 边比较的字段。position 从 0 起（界面显示第几个时 +1）。 */
export const EDGE_CHANGE_FIELDS = [
  'kind',
  'position',
  'labelEn',
  'labelZh',
] as const;

export type FaqFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
};

/** 时间线上提到的一条 FAQ（当前的问题文字；已删除的也照样显示）。 */
export type FaqChangeNode = Pick<
  HelpdeskFaq,
  'id' | 'key' | 'questionEn' | 'questionZh' | 'status'
>;

export type FaqChangePerson = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
};

export type FaqChangeRelease = {
  version: number;
  status: FaqReleaseRow['status'];
  sourceVersion: number | null;
  /** 图检查发现的问题数（新建版本时）。 */
  problems: number;
};

export type FaqChange = {
  /** `${来源}:${行 id}`，全局唯一。 */
  id: string;
  at: string;
  /** null = 种子脚本或系统写入。 */
  employee: FaqChangePerson | null;
  subject: FaqChangeSubject;
  action: FaqChangeAction;
  /** FAQ 本身；追问 / 选项是父节点；问法是它属于的 FAQ；版本为 null。 */
  faq: FaqChangeNode | null;
  /** 追问 / 选项的子节点。 */
  child: FaqChangeNode | null;
  phrasing: { locale: string; text: string; source: string } | null;
  release: FaqChangeRelease | null;
  /** FAQ 的版本号变化（新建：from = null）。 */
  version: { from: number | null; to: number } | null;
  changes: FaqFieldChange[];
  /** 学员是否已经看到（版本事件为 null）。 */
  learners: 'live' | 'pending' | null;
  /** 第一次把它带上线的版本号（还没上线 / 还没有发布版本时为 null）。 */
  liveIn: number | null;
};

/** 仓库读出的一行原始记录。 */
export type RawFaqChange =
  | {
      source: 'faq';
      id: string;
      at: string;
      employeeId: string | null;
      action: 'create' | 'update' | 'archive';
      version: number;
      snapshot: Record<string, unknown>;
      previous: Record<string, unknown> | null;
      faq: FaqChangeNode | null;
    }
  | {
      source: 'edge';
      id: string;
      at: string;
      employeeId: string | null;
      action: 'create' | 'update' | 'delete';
      before: Partial<FaqEdgeRow> | null;
      after: Partial<FaqEdgeRow> | null;
      faq: FaqChangeNode | null;
      child: FaqChangeNode | null;
    }
  | {
      source: 'phrasing';
      id: string;
      at: string;
      employeeId: string | null;
      action: 'create' | 'delete';
      locale: string;
      text: string;
      phrasingSource: string;
      faq: FaqChangeNode | null;
    }
  | {
      source: 'release_created' | 'release_published';
      id: string;
      at: string;
      employeeId: string | null;
      release: FaqChangeRelease;
    };

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** FAQ 两版之间改了的字段；新建（previous = null）列出有内容的字段。 */
export function faqFieldChanges(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): FaqFieldChange[] {
  const out: FaqFieldChange[] = [];
  for (const field of FAQ_CHANGE_FIELDS) {
    const before = previous === null ? null : (previous[field] ?? null);
    const after = next[field] ?? null;
    if (previous === null) {
      const empty =
        after === null ||
        after === '' ||
        (Array.isArray(after) && after.length === 0);
      if (!empty) out.push({ field, before: null, after });
      continue;
    }
    if (!same(before, after)) out.push({ field, before, after });
  }
  return out;
}

/** 边的一次写入 → 动作与改了的字段（只改了顺序 = reordered）。 */
export function edgeChange(
  action: 'create' | 'update' | 'delete',
  before: Partial<FaqEdgeRow> | null,
  after: Partial<FaqEdgeRow> | null,
): { action: FaqChangeAction; changes: FaqFieldChange[] } {
  const changes: FaqFieldChange[] = [];
  for (const field of EDGE_CHANGE_FIELDS) {
    const b = before === null ? null : (before[field] ?? null);
    const a = after === null ? null : (after[field] ?? null);
    if (!same(b, a)) changes.push({ field, before: b, after: a });
  }
  if (action === 'create') return { action: 'added', changes };
  if (action === 'delete') return { action: 'removed', changes };
  const onlyOrder =
    changes.length > 0 && changes.every((c) => c.field === 'position');
  return { action: onlyOrder ? 'reordered' : 'changed', changes };
}

/**
 * 一个版本的快照实际取自什么时候的工作副本：普通版本 = 它的新建时间；回滚版本复制自更早的版本，
 * 沿 sourceVersion 往回找。
 */
function frozenAt(
  release: FaqReleaseRow,
  byVersion: Map<number, FaqReleaseRow>,
): string {
  let current = release;
  const seen = new Set<number>();
  while (current.sourceVersion !== null && !seen.has(current.version)) {
    seen.add(current.version);
    const source = byVersion.get(current.sourceVersion);
    if (!source) break;
    current = source;
  }
  return current.createdAt;
}

/**
 * 学员是否已看到一次在 at 保存的改动：
 * - 还没有任何发布版本：保存即生效（Portal 逐条读已发布的 FAQ）→ live；
 * - 当前上线的版本冻结于 at 之后 → live；否则 pending（要等下一次发布）。
 * liveIn：第一次把它带上线的普通版本（曾经发布过、冻结于 at 之后、版本号最小）。
 */
export function learnersState(
  at: string,
  releases: readonly FaqReleaseRow[],
): { learners: 'live' | 'pending'; liveIn: number | null } {
  const byVersion = new Map(releases.map((r) => [r.version, r]));
  const time = Date.parse(at);
  const shipped = releases
    .filter(
      (r) =>
        r.publishedAt !== null &&
        r.sourceVersion === null &&
        Date.parse(r.createdAt) >= time,
    )
    .sort((a, b) => a.version - b.version);
  const liveIn = shipped[0]?.version ?? null;
  const current = releases.find((r) => r.status === 'published');
  if (!current) return { learners: 'live', liveIn };
  return {
    learners:
      Date.parse(frozenAt(current, byVersion)) >= time ? 'live' : 'pending',
    liveIn,
  };
}

/** 原始记录 → 时间线的一行（员工名字由服务填）。 */
export function toFaqChange(
  raw: RawFaqChange,
  releases: readonly FaqReleaseRow[],
  people: ReadonlyMap<string, FaqChangePerson>,
): FaqChange {
  const employee =
    raw.employeeId === null
      ? null
      : (people.get(raw.employeeId) ?? {
          id: raw.employeeId,
          name: '',
          role: null,
          email: null,
        });
  const base = {
    at: raw.at,
    employee,
    faq: null,
    child: null,
    phrasing: null,
    release: null,
    version: null,
    changes: [] as FaqFieldChange[],
  };
  switch (raw.source) {
    case 'faq':
      return {
        ...base,
        id: `faq:${raw.id}`,
        subject: 'faq',
        action:
          raw.action === 'create'
            ? 'created'
            : raw.action === 'archive'
              ? 'archived'
              : 'edited',
        faq: raw.faq,
        version: {
          from: raw.action === 'create' ? null : raw.version - 1,
          to: raw.version,
        },
        changes: faqFieldChanges(
          raw.action === 'create' ? null : raw.previous,
          raw.snapshot,
        ),
        ...learnersState(raw.at, releases),
      };
    case 'edge': {
      const edge = raw.after ?? raw.before;
      const { action, changes } = edgeChange(raw.action, raw.before, raw.after);
      return {
        ...base,
        id: `edge:${raw.id}`,
        subject: edge?.kind === 'option' ? 'option' : 'follow_up',
        action,
        faq: raw.faq,
        child: raw.child,
        changes,
        ...learnersState(raw.at, releases),
      };
    }
    case 'phrasing':
      return {
        ...base,
        id: `phrasing:${raw.id}`,
        subject: 'phrasing',
        action: raw.action === 'create' ? 'added' : 'removed',
        faq: raw.faq,
        phrasing: {
          locale: raw.locale,
          text: raw.text,
          source: raw.phrasingSource,
        },
        ...learnersState(raw.at, releases),
      };
    default:
      return {
        ...base,
        id: `${raw.source}:${raw.id}`,
        subject: 'release',
        action:
          raw.source === 'release_published'
            ? 'published'
            : raw.release.sourceVersion !== null
              ? 'rolled_back'
              : 'version_created',
        release: raw.release,
        learners: null,
        liveIn: null,
      };
  }
}
