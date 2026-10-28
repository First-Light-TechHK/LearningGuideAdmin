import type {
  HelpdeskQuestion,
  QuestionRevision,
} from '../../modules/helpdesk/questions/questionContracts';
import type {
  QuestionFilter,
  QuestionPatch,
  QuestionRepository,
  RevisionAction,
  WriteResult,
} from '../../modules/helpdesk/questions/questionRepository';

/**
 * 单测用的内存仓库：语义与 PostgreSQL 实现一致（版本号条件更新、同一次写入追加修订行、
 * 冲突时什么都不改）。真实 SQL 由 helpdesk-questions-repository.pg.spec.ts 覆盖。
 */
export function createMemoryQuestionRepository(seed: HelpdeskQuestion[] = []) {
  const rows = new Map<string, HelpdeskQuestion>(
    seed.map((row) => [row.id, { ...row }]),
  );
  const revisions: QuestionRevision[] = [];
  let tick = 0;
  const stamp = () =>
    new Date(Date.UTC(2026, 9, 28, 0, 0, tick++)).toISOString();

  function addRevision(
    row: HelpdeskQuestion,
    action: RevisionAction,
    employeeId: string | null,
  ) {
    revisions.push({
      id: `rev-${revisions.length + 1}`,
      questionId: row.id,
      version: row.version,
      action,
      employeeId,
      at: row.updatedAt,
      snapshot: { ...row, keywords: [...row.keywords] },
    });
  }

  const repository: QuestionRepository & {
    rows: Map<string, HelpdeskQuestion>;
    revisionRows: QuestionRevision[];
  } = {
    rows,
    revisionRows: revisions,

    list(filter: QuestionFilter) {
      const q = filter.q?.toLowerCase();
      return Promise.resolve(
        [...rows.values()]
          .filter(
            (row) =>
              (!filter.locale || row.locale === filter.locale) &&
              (!filter.category || row.category === filter.category) &&
              filter.statuses.includes(row.status) &&
              (!q ||
                row.question.toLowerCase().includes(q) ||
                row.answer.toLowerCase().includes(q) ||
                row.keywords.some((k) => k.includes(q))),
          )
          .sort(
            (a, b) =>
              a.locale.localeCompare(b.locale) ||
              a.sortOrder - b.sortOrder ||
              a.createdAt.localeCompare(b.createdAt),
          )
          .map((row) => ({ ...row })),
      );
    },

    get(id) {
      const row = rows.get(id);
      return Promise.resolve(row ? { ...row } : null);
    },

    nextSortOrder(locale) {
      const max = Math.max(
        0,
        ...[...rows.values()]
          .filter((row) => row.locale === locale)
          .map((row) => row.sortOrder),
      );
      return Promise.resolve(max + 10);
    },

    insert(question, employeeId) {
      const at = stamp();
      const row = { ...question, createdAt: at, updatedAt: at };
      rows.set(row.id, row);
      addRevision(row, 'create', employeeId);
      return Promise.resolve({ ...row });
    },

    update(
      id: string,
      expectedVersion: number,
      patch: QuestionPatch,
      action: RevisionAction,
      employeeId: string | null,
    ): Promise<WriteResult<HelpdeskQuestion>> {
      const current = rows.get(id);
      if (!current) return Promise.resolve({ kind: 'not_found' });
      if (current.version !== expectedVersion)
        return Promise.resolve({
          kind: 'conflict',
          currentVersion: current.version,
        });
      const row: HelpdeskQuestion = {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedBy: employeeId,
        updatedAt: stamp(),
      };
      rows.set(id, row);
      addRevision(row, action, employeeId);
      return Promise.resolve({ kind: 'ok', value: { ...row } });
    },

    reorder(items, employeeId) {
      for (const item of items) {
        const current = rows.get(item.id);
        if (!current) return Promise.resolve({ kind: 'not_found' as const });
        if (current.version !== item.version)
          return Promise.resolve({
            kind: 'conflict' as const,
            currentVersion: current.version,
          });
      }
      const out: HelpdeskQuestion[] = [];
      items.forEach((item, index) => {
        const current = rows.get(item.id) as HelpdeskQuestion;
        const sortOrder = (index + 1) * 10;
        if (current.sortOrder === sortOrder) {
          out.push({ ...current });
          return;
        }
        const row = {
          ...current,
          sortOrder,
          version: current.version + 1,
          updatedBy: employeeId,
          updatedAt: stamp(),
        };
        rows.set(row.id, row);
        addRevision(row, 'update', employeeId);
        out.push({ ...row });
      });
      return Promise.resolve({ kind: 'ok' as const, value: out });
    },

    revisions(id) {
      return Promise.resolve(
        revisions
          .filter((rev) => rev.questionId === id)
          .sort((a, b) => b.version - a.version),
      );
    },

    listPublished(locale, featuredOnly) {
      return Promise.resolve(
        [...rows.values()]
          .filter(
            (row) =>
              row.locale === locale &&
              row.status === 'published' &&
              (!featuredOnly || row.featured),
          )
          .sort(
            (a, b) =>
              a.sortOrder - b.sortOrder ||
              a.createdAt.localeCompare(b.createdAt),
          )
          .map((row) => ({ ...row })),
      );
    },

    searchCandidates() {
      return Promise.resolve([]);
    },
  };
  return repository;
}
