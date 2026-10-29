import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FAQ_CANDIDATES_SQL } from '../modules/helpdesk/faqs/faqRepository';

/**
 * 英文候选检索的 GIN 索引表达式必须与查询里的 to_tsvector 表达式完全一致（同一个文本配置），
 * 否则规划器永远用不上这个索引。PostgreSQL 实测见 helpdesk-faqs-repository.pg.spec.ts。
 */
const MIGRATION = join(
  __dirname,
  '../../../prisma/migrations/20261029090000_helpdesk_faqs/migration.sql',
);

/** 去掉引号、表别名和多余空白，只比较表达式本身。 */
function normalise(expression: string): string {
  return expression
    .replace(/"/g, '')
    .replace(/\bf\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function vectors(sql: string): string[] {
  return [...sql.matchAll(/to_tsvector\(\s*'[a-z]+'\s*,[^)]*\)/g)].map((m) =>
    normalise(m[0]),
  );
}

describe('Helpdesk FAQ search index', () => {
  const migration = readFileSync(MIGRATION, 'utf8');
  const index = /CREATE INDEX "helpdesk_faqs_search_en_idx"[^;]*;/.exec(
    migration,
  );

  it('indexes exactly the to_tsvector expression the candidate query filters and ranks with', () => {
    expect(index).not.toBeNull();
    const indexed = vectors(index![0]);
    expect(indexed).toHaveLength(1);
    const queried = vectors(FAQ_CANDIDATES_SQL);
    expect(queried.length).toBeGreaterThanOrEqual(2);
    for (const expression of queried) expect(expression).toBe(indexed[0]);
  });

  it('uses one text search configuration everywhere (english, as to_tsquery)', () => {
    expect(vectors(index![0])[0]).toBe(
      "to_tsvector('english', question_en || ' ' || answer_en)",
    );
    const queries = [
      ...FAQ_CANDIDATES_SQL.matchAll(/to_tsquery\(\s*'([a-z]+)'/g),
    ].map((m) => m[1]);
    expect(queries.length).toBeGreaterThanOrEqual(1);
    expect(new Set(queries)).toEqual(new Set(['english']));
  });
});
