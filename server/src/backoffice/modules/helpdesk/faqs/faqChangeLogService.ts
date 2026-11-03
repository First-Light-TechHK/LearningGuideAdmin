import { isUuid } from '../../../../common/uuidv7';
import { displayNameFromEmail } from '../../../contracts/employee';
import { query } from '../../../lib/db';
import { HelpdeskError } from '../portalHelpdeskClient';
import {
  FAQ_CHANGE_SUBJECTS,
  toFaqChange,
  type FaqChange,
  type FaqChangePerson,
  type FaqChangeSubject,
  type RawFaqChange,
} from './faqChangeLog';
import {
  createPgFaqChangeLogRepository,
  type FaqChangeFilter,
  type FaqChangeLogRepository,
} from './faqChangeLogRepository';
import { FAQ_LIMITS } from './faqContracts';
import {
  createPgFaqGraphRepository,
  type FaqReleaseRow,
} from './faqGraphRepository';

/**
 * BackOffice Change Log（Figma 草案 2.6–2.9）：谁、什么时候、改了什么，学员看到了没有。
 * - 全部记录：GET /api/helpdesk/faq-changes?subject=&employee=&faq=&from=&to=&q=&page=&pageSize=；
 *   employee = 员工 id 或 system（种子 / 系统写入）；from / to = 日期（YYYY-MM-DD，to 含当天）或完整时间。
 * - 一条 FAQ 的修改历史：GET /api/helpdesk/faqs/:faqId/changes —— 它自己的修订、它作为父或子的边、
 *   它的问法，另外插入「随 vN 上线」：带上它的改动第一次发布的那一刻。
 * 员工名字取登录邮箱 @ 之前（与会话显示名一致，PRD BR-PORT-018）。
 */

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

export const FAQ_CHANGE_LIMITS = {
  pageSize: 10,
  pageSizeMax: 50,
  /** 一条 FAQ 的历史一次读出的上限（在内存里插入上线事件后再分页）。 */
  historyMax: 500,
} as const;

export type FaqChangePeopleLookup = (
  ids: readonly string[],
) => Promise<Map<string, FaqChangePerson>>;

/** employees 表归登录模块；这里只读 id、邮箱、角色。 */
export const pgFaqChangePeople: FaqChangePeopleLookup = async (ids) => {
  if (ids.length === 0) return new Map();
  const rows = await query<{
    employee_id: string;
    login_email: string;
    role: string;
  }>(
    'SELECT employee_id, login_email, role FROM employees WHERE employee_id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(
    rows.map((row) => [
      row.employee_id,
      {
        id: row.employee_id,
        name: displayNameFromEmail(row.login_email),
        role: row.role,
        email: row.login_email,
      },
    ]),
  );
};

/** 控制器原样转来的查询参数（类型未知）。 */
export type FaqChangeQuery = Partial<
  Record<
    'subject' | 'employee' | 'faq' | 'from' | 'to' | 'q' | 'page' | 'pageSize',
    unknown
  >
>;

export type FaqChangePage = {
  changes: FaqChange[];
  total: number;
  page: number;
  pageSize: number;
  /** 记录里出现过的员工（「Changed by」筛选的选项，按名字排）。 */
  people: FaqChangePerson[];
};

function text(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string')
    throw invalid(`${name} must be a single text value`);
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function positiveInt(
  raw: unknown,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = text(raw, name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > max)
    throw invalid(`${name} must be 1-${max}`);
  return n;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** 日期或完整时间 → ISO；to 只给日期时取次日零点（含当天）。 */
function instant(raw: unknown, name: 'from' | 'to'): string | undefined {
  const value = text(raw, name);
  if (value === undefined) return undefined;
  if (!DATE_ONLY.test(value) && !DATE_TIME.test(value))
    throw invalid(`${name} must be a date (YYYY-MM-DD) or an ISO time`);
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw invalid(`${name} is not a real date`);
  if (DATE_ONLY.test(value) && value !== date.toISOString().slice(0, 10))
    throw invalid(`${name} is not a real date`);
  if (name === 'to' && DATE_ONLY.test(value))
    date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function subject(raw: unknown): FaqChangeSubject | undefined {
  const value = text(raw, 'subject');
  if (value === undefined || value === 'all') return undefined;
  if (!(FAQ_CHANGE_SUBJECTS as readonly string[]).includes(value))
    throw invalid('Unknown subject');
  return value as FaqChangeSubject;
}

function employee(raw: unknown): string | null | undefined {
  const value = text(raw, 'employee');
  if (value === undefined || value === 'all') return undefined;
  if (value === 'system') return null;
  if (!isUuid(value)) throw invalid('Invalid employee');
  return value.toLowerCase();
}

/** 只看一条 FAQ 的（「Open in Change Log」）：它自己的、它作为父或子的边、它的问法。 */
function faq(raw: unknown): string | undefined {
  const value = text(raw, 'faq');
  if (value === undefined) return undefined;
  if (!isUuid(value)) throw invalid('Invalid FAQ id');
  return value.toLowerCase();
}

function search(raw: unknown): string | undefined {
  const value = text(raw, 'q');
  if (value !== undefined && value.length > FAQ_LIMITS.searchMax)
    throw invalid('Search is too long');
  return value;
}

function sortPeople(people: Iterable<FaqChangePerson>): FaqChangePerson[] {
  return [...people].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

function newestFirst(
  a: { at: string; id: string },
  b: { at: string; id: string },
) {
  const diff = Date.parse(b.at) - Date.parse(a.at);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 一条 FAQ 的历史里「随 vN 上线」那一行（发布事件，带发布人）。 */
function wentLive(release: FaqReleaseRow): RawFaqChange {
  return {
    source: 'release_published',
    id: release.id,
    at: release.publishedAt ?? release.createdAt,
    employeeId: release.publishedBy,
    release: {
      version: release.version,
      status: release.status,
      sourceVersion: release.sourceVersion,
      problems: Array.isArray(release.checks?.problems)
        ? release.checks.problems.length
        : 0,
    },
  };
}

export type FaqChangeLogServiceOptions = {
  log?: FaqChangeLogRepository;
  releases?: () => Promise<FaqReleaseRow[]>;
  people?: FaqChangePeopleLookup;
};

export function createFaqChangeLogService(
  options: FaqChangeLogServiceOptions = {},
) {
  const log = options.log ?? createPgFaqChangeLogRepository();
  const releases =
    options.releases ??
    (() => {
      const graph = createPgFaqGraphRepository();
      return graph.releases();
    });
  const people = options.people ?? pgFaqChangePeople;

  async function expand(
    raws: RawFaqChange[],
    releaseRows: FaqReleaseRow[],
    extraIds: readonly string[] = [],
  ) {
    const ids = [
      ...new Set([
        ...raws.flatMap((raw) => (raw.employeeId ? [raw.employeeId] : [])),
        ...extraIds,
      ]),
    ];
    const found = await people(ids);
    return {
      changes: raws.map((raw) => toFaqChange(raw, releaseRows, found)),
      people: found,
    };
  }

  return {
    async list(input: FaqChangeQuery): Promise<FaqChangePage> {
      const filter: Omit<FaqChangeFilter, 'offset' | 'limit'> = {
        subject: subject(input.subject),
        employeeId: employee(input.employee),
        from: instant(input.from, 'from'),
        to: instant(input.to, 'to'),
        q: search(input.q),
        faqId: faq(input.faq),
      };
      if (filter.from && filter.to && filter.from >= filter.to)
        throw invalid('from must be before to');
      const page = positiveInt(input.page, 'page', 1, 100_000);
      const pageSize = positiveInt(
        input.pageSize,
        'pageSize',
        FAQ_CHANGE_LIMITS.pageSize,
        FAQ_CHANGE_LIMITS.pageSizeMax,
      );
      const [result, releaseRows, everyone] = await Promise.all([
        log.page({ ...filter, offset: (page - 1) * pageSize, limit: pageSize }),
        releases(),
        log.employeeIds(),
      ]);
      const expanded = await expand(result.changes, releaseRows, everyone);
      return {
        changes: expanded.changes,
        total: result.total,
        page,
        pageSize,
        people: sortPeople(
          everyone.map(
            (id) =>
              expanded.people.get(id) ?? {
                id,
                name: '',
                role: null,
                email: null,
              },
          ),
        ),
      };
    },

    /** 一条 FAQ 的修改历史（新的在前），中间插入它的改动随哪一版上线。 */
    async forFaq(
      rawFaqId: string,
      input: Pick<FaqChangeQuery, 'page' | 'pageSize'>,
    ): Promise<Omit<FaqChangePage, 'people'> & { truncated: boolean }> {
      if (typeof rawFaqId !== 'string' || !isUuid(rawFaqId))
        throw invalid('Invalid FAQ id');
      const faqId = rawFaqId.toLowerCase();
      const page = positiveInt(input.page, 'page', 1, 100_000);
      const pageSize = positiveInt(
        input.pageSize,
        'pageSize',
        FAQ_CHANGE_LIMITS.pageSize,
        FAQ_CHANGE_LIMITS.pageSizeMax,
      );
      const [result, releaseRows] = await Promise.all([
        log.page({ faqId, offset: 0, limit: FAQ_CHANGE_LIMITS.historyMax }),
        releases(),
      ]);
      const own = await expand(result.changes, releaseRows);
      const versions = new Set(
        own.changes.flatMap((change) =>
          change.liveIn === null ? [] : [change.liveIn],
        ),
      );
      const live = releaseRows
        .filter((row) => versions.has(row.version) && row.publishedAt !== null)
        .map(wentLive);
      const liveRows = (await expand(live, releaseRows)).changes;
      const all = [...own.changes, ...liveRows].sort(newestFirst);
      const start = (page - 1) * pageSize;
      return {
        changes: all.slice(start, start + pageSize),
        total: all.length,
        page,
        pageSize,
        /** 这条 FAQ 的记录超过一次读出的上限，只列了最新的那些。 */
        truncated: result.total > result.changes.length,
      };
    },
  };
}

export type FaqChangeLogService = ReturnType<typeof createFaqChangeLogService>;
