import {
  edgeChange,
  faqFieldChanges,
  learnersState,
  toFaqChange,
} from '../modules/helpdesk/faqs/faqChangeLog';
import type { FaqReleaseRow } from '../modules/helpdesk/faqs/faqGraphRepository';

/**
 * Change Log 的纯函数（faqChangeLog.ts）：逐字段的改前改后、边的动作、「学员是否已看到」与回滚。
 * 数据库上的整条链路见 helpdesk-faq-change-log.pg.spec.ts。
 */
function release(
  version: number,
  fields: Partial<FaqReleaseRow> = {},
): FaqReleaseRow {
  return {
    id: `r${version}`,
    version,
    status: 'superseded',
    snapshotHash: 'h',
    checks: {
      passed: true,
      problems: [],
    } as unknown as FaqReleaseRow['checks'],
    evalReport: null,
    sourceVersion: null,
    createdBy: null,
    createdAt: `2026-10-0${version}T00:00:00.000Z`,
    publishedBy: null,
    publishedAt: `2026-10-0${version}T01:00:00.000Z`,
    evalRun: null,
    ...fields,
  };
}

describe('faqFieldChanges', () => {
  it('lists only the fields that differ, keywords and signals as whole lists', () => {
    expect(
      faqFieldChanges(
        { questionEn: 'A', keywords: ['x'], signals: [], popular: false },
        { questionEn: 'A', keywords: ['x', 'y'], signals: [], popular: true },
      ),
    ).toEqual([
      { field: 'popular', before: false, after: true },
      { field: 'keywords', before: ['x'], after: ['x', 'y'] },
    ]);
  });

  it('on create lists the fields that have content (false counts, empty lists do not)', () => {
    expect(
      faqFieldChanges(null, {
        key: 'k',
        popular: false,
        questionEn: 'Q',
        answerEn: '',
        keywords: [],
      }).map((c) => c.field),
    ).toEqual(['key', 'popular', 'questionEn']);
  });
});

describe('edgeChange', () => {
  it('names the action: added, removed, reordered (only the position moved) or changed', () => {
    const edge = {
      kind: 'follow_up' as const,
      position: 0,
      labelEn: null,
      labelZh: null,
    };
    expect(edgeChange('create', null, edge).action).toBe('added');
    expect(edgeChange('delete', edge, null).action).toBe('removed');
    expect(edgeChange('update', edge, { ...edge, position: 2 })).toEqual({
      action: 'reordered',
      changes: [{ field: 'position', before: 0, after: 2 }],
    });
    expect(
      edgeChange('update', edge, { ...edge, position: 1, labelEn: 'Hi' })
        .action,
    ).toBe('changed');
  });
});

describe('learnersState', () => {
  it('nothing published yet: live as soon as it is saved', () => {
    expect(learnersState('2026-10-05T00:00:00Z', [])).toEqual({
      learners: 'live',
      liveIn: null,
    });
    expect(
      learnersState('2026-10-05T00:00:00Z', [
        release(1, { status: 'draft', publishedAt: null }),
      ]),
    ).toEqual({ learners: 'live', liveIn: null });
  });

  it('live when the published release was frozen after the change; liveIn = the first release that shipped it', () => {
    const releases = [
      release(1),
      release(2),
      release(3, { status: 'published' }),
    ];
    expect(learnersState('2026-10-01T12:00:00Z', releases)).toEqual({
      learners: 'live',
      liveIn: 2,
    });
    expect(learnersState('2026-10-04T00:00:00Z', releases)).toEqual({
      learners: 'pending',
      liveIn: null,
    });
  });

  it('a rollback inherits the frozen time of its source; it never counts as the release that shipped a change', () => {
    const releases = [
      release(1),
      release(2),
      release(3, {
        status: 'published',
        sourceVersion: 1,
        createdAt: '2026-10-09T00:00:00.000Z',
      }),
    ];
    expect(learnersState('2026-10-01T12:00:00Z', releases)).toEqual({
      learners: 'pending',
      liveIn: 2,
    });
    expect(learnersState('2026-09-30T00:00:00Z', releases)).toEqual({
      learners: 'live',
      liveIn: 1,
    });
  });

  it('a release that was never published does not count as liveIn', () => {
    const releases = [
      release(1, { status: 'published' }),
      release(2, { status: 'rejected', publishedAt: null }),
    ];
    expect(learnersState('2026-10-01T12:00:00Z', releases)).toEqual({
      learners: 'pending',
      liveIn: null,
    });
  });
});

describe('toFaqChange', () => {
  it('keeps an unknown employee id with an empty name (account removed); null = system', () => {
    const raw = {
      source: 'phrasing' as const,
      id: 'p1',
      at: '2026-10-05T00:00:00Z',
      employeeId: 'gone',
      action: 'create' as const,
      locale: 'en-GB',
      text: 'hi',
      phrasingSource: 'staff',
      faq: null,
    };
    expect(toFaqChange(raw, [], new Map()).employee).toEqual({
      id: 'gone',
      name: '',
      role: null,
      email: null,
    });
    expect(
      toFaqChange({ ...raw, employeeId: null }, [], new Map()).employee,
    ).toBeNull();
    expect(toFaqChange(raw, [], new Map()).id).toBe('phrasing:p1');
  });

  it('a release copied from an earlier version is a rollback', () => {
    const base = {
      id: 'r3',
      at: '2026-10-05T00:00:00Z',
      employeeId: null,
      release: {
        version: 3,
        status: 'published' as const,
        sourceVersion: 1,
        problems: 0,
      },
    };
    expect(
      toFaqChange({ ...base, source: 'release_created' }, [], new Map()).action,
    ).toBe('rolled_back');
    expect(
      toFaqChange({ ...base, source: 'release_published' }, [], new Map())
        .action,
    ).toBe('published');
    expect(
      toFaqChange(
        {
          ...base,
          source: 'release_created',
          release: { ...base.release, sourceVersion: null },
        },
        [],
        new Map(),
      ).action,
    ).toBe('version_created');
  });
});
