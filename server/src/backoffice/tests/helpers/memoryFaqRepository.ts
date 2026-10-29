import type {
  FaqRevision,
  FaqRevisionAction,
  HelpdeskFaq,
} from '../../modules/helpdesk/faqs/faqContracts';
import type {
  FaqFilter,
  FaqPatch,
  FaqRepository,
  FaqSearch,
  PublishedFilter,
  WriteResult,
} from '../../modules/helpdesk/faqs/faqRepository';

/**
 * 单测用的内存仓库：语义与 PostgreSQL 实现一致（版本号条件更新、同一次写入追加修订行、
 * 冲突时什么都不改、Idempotency-Key 只建一条）。检索只做简单的包含匹配；真实 SQL 由
 * helpdesk-faqs-repository.pg.spec.ts 覆盖。
 */
export function createMemoryFaqRepository(seed: HelpdeskFaq[] = []) {
  const rows = new Map<string, HelpdeskFaq>(
    seed.map((row) => [row.id, { ...row }]),
  );
  const keys = new Map<string, string>();
  const revisions: FaqRevision[] = [];
  let tick = 0;
  const stamp = () =>
    new Date(Date.UTC(2026, 9, 28, 0, 0, tick++)).toISOString();

  function addRevision(
    row: HelpdeskFaq,
    action: FaqRevisionAction,
    employeeId: string | null,
  ) {
    revisions.push({
      id: `rev-${revisions.length + 1}`,
      faqId: row.id,
      version: row.version,
      action,
      employeeId,
      at: row.updatedAt,
      snapshot: {
        ...row,
        keywords: [...row.keywords],
        signals: [...row.signals],
      },
    });
  }

  const newestFirst = (a: HelpdeskFaq, b: HelpdeskFaq) =>
    b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);

  function text(row: HelpdeskFaq): string {
    return [
      row.questionEn,
      row.answerEn,
      row.questionZh,
      row.answerZh,
      ...row.keywords,
    ]
      .join('\n')
      .toLowerCase();
  }

  const repository: FaqRepository & {
    rows: Map<string, HelpdeskFaq>;
    revisionRows: FaqRevision[];
    searches: FaqSearch[];
  } = {
    rows,
    revisionRows: revisions,
    searches: [],

    list(filter: FaqFilter) {
      const q = filter.q?.toLowerCase();
      const matched = [...rows.values()]
        .filter(
          (row) =>
            row.status === 'published' &&
            (!filter.category || row.category === filter.category) &&
            (filter.popular === undefined || row.popular === filter.popular) &&
            (!q || text(row).includes(q)),
        )
        .sort(newestFirst);
      return Promise.resolve({
        faqs: matched
          .slice(filter.offset, filter.offset + filter.limit)
          .map((row) => ({ ...row })),
        total: matched.length,
      });
    },

    get(id) {
      const row = rows.get(id);
      return Promise.resolve(row ? { ...row } : null);
    },

    insert(faq, employeeId, idempotencyKey) {
      if (idempotencyKey && keys.has(idempotencyKey)) {
        const existing = rows.get(keys.get(idempotencyKey)!)!;
        return Promise.resolve({ faq: { ...existing }, created: false });
      }
      const now = stamp();
      const row: HelpdeskFaq = {
        ...faq,
        keywords: [...faq.keywords],
        signals: [...faq.signals],
        version: 1,
        createdBy: employeeId,
        updatedBy: employeeId,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      if (idempotencyKey) keys.set(idempotencyKey, row.id);
      addRevision(row, 'create', employeeId);
      return Promise.resolve({ faq: { ...row }, created: true });
    },

    update(
      id: string,
      expectedVersion: number,
      patch: FaqPatch,
      action: FaqRevisionAction,
      employeeId: string | null,
    ): Promise<WriteResult<HelpdeskFaq>> {
      const row = rows.get(id);
      if (!row) return Promise.resolve({ kind: 'not_found' });
      if (row.version !== expectedVersion)
        return Promise.resolve({
          kind: 'conflict',
          currentVersion: row.version,
        });
      const updated: HelpdeskFaq = {
        ...row,
        ...patch,
        version: row.version + 1,
        updatedBy: employeeId,
        updatedAt: stamp(),
      };
      rows.set(id, updated);
      addRevision(updated, action, employeeId);
      return Promise.resolve({ kind: 'ok', value: { ...updated } });
    },

    revisions(id) {
      return Promise.resolve(
        revisions
          .filter((r) => r.faqId === id)
          .sort((a, b) => b.version - a.version),
      );
    },

    listPublished(filter: PublishedFilter) {
      return Promise.resolve(
        [...rows.values()]
          .filter(
            (row) =>
              row.status === 'published' &&
              (!filter.category || row.category === filter.category) &&
              (filter.popular === undefined ||
                row.popular === filter.popular) &&
              !(filter.excludeIds ?? []).includes(row.id),
          )
          .sort(
            (a, b) =>
              Number(b.popular) - Number(a.popular) ||
              Number(b.category === filter.boost) -
                Number(a.category === filter.boost) ||
              newestFirst(a, b),
          )
          .slice(0, filter.limit)
          .map((row) => ({ ...row })),
      );
    },

    searchPublished(search: FaqSearch) {
      repository.searches.push(search);
      const needle = search.text.trim().toLowerCase();
      if (needle === '') return Promise.resolve([]);
      return Promise.resolve(
        [...rows.values()]
          .filter(
            (row) =>
              row.status === 'published' &&
              (!search.category || row.category === search.category) &&
              (search.popular === undefined ||
                row.popular === search.popular) &&
              text(row).includes(needle),
          )
          .slice(0, search.limit)
          .map((row) => ({ ...row, score: 1 })),
      );
    },
  };
  return repository;
}
