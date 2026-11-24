import assert from 'node:assert/strict';

import {
  ALL_CAPABILITIES,
  parseEnabledCapabilities,
} from '../../common/capabilities';
import type { EmployeeRole } from '../contracts/employee';
import {
  COURSE_ACTION_FEATURES,
  FEATURE_CATALOG,
  MODULE_FEATURES,
  effectiveCourseAction,
  effectiveMenuLevel,
  effectiveModuleLevel,
  isFeatureKey,
  isCourseActionFeatureAllowed,
  isMenuActionAllowed,
  isModuleFeatureAllowed,
  resolveBaselineFeatures,
  resolveEffectiveFeatures,
  type FeatureGrantMap,
  type FeatureKey,
} from '../modules/rbac/features';
import type { ActionKind } from '../modules/rbac/permissions';

/**
 * 账号级功能开关的生效规则（owner 2026-11-20）：
 * effective = 环境能力 ∩ 角色矩阵 ∩ 账号开关。
 * - 缺省继承角色；
 * - module.<menu> = false → NONE；= true 且角色 NONE → 至少 VIEW；
 * - course.<action> = false → 拒绝；= true → 若模块可见则允许；
 * - 环境能力永远优先，账号开关不能越过。
 */

const grants = (): Map<FeatureKey, boolean> => new Map();
const withGrant = (entries: Array<[FeatureKey, boolean]>): FeatureGrantMap =>
  new Map(entries);

describe('FEATURE_CATALOG 单一事实来源', () => {
  it('exports exactly the approved module and course-action keys in fixed order', () => {
    assert.deepEqual(
      [...MODULE_FEATURES],
      [
        'module.course',
        'module.knowledge',
        'module.ai',
        'module.students',
        'module.helpdesk',
        'module.operations',
        'module.reporting',
        'module.order',
        'module.settings',
        'module.accounts',
      ],
    );
    assert.deepEqual(
      [...COURSE_ACTION_FEATURES],
      [
        'course.view',
        'course.edit',
        'course.publish',
        'course.import',
        'course.export',
      ],
    );
    assert.deepEqual(
      FEATURE_CATALOG.map((entry) => entry.key),
      [...MODULE_FEATURES, ...COURSE_ACTION_FEATURES],
    );
  });

  it('groups every key and keeps sortOrder ascending inside each group', () => {
    for (const entry of FEATURE_CATALOG) {
      assert.ok(
        entry.group === 'module' || entry.group === 'course',
        entry.key,
      );
      assert.equal(
        entry.group,
        entry.key.startsWith('module.') ? 'module' : 'course',
      );
    }
    for (const group of ['module', 'course'] as const) {
      const orders = FEATURE_CATALOG.filter((e) => e.group === group).map(
        (e) => e.sortOrder,
      );
      assert.deepEqual(
        orders,
        [...orders].sort((a, b) => a - b),
      );
      assert.equal(new Set(orders).size, orders.length);
    }
  });

  it('recognises catalogue keys only (anything else is rejected)', () => {
    for (const entry of FEATURE_CATALOG)
      assert.equal(isFeatureKey(entry.key), true);
    for (const bad of [
      'module',
      'module.unknown',
      'course',
      'course.review',
      // 新建/删除不属于账号级功能目录（与 permissions.md「新建/删除仅 ADMIN」一致），
      // 它们只由角色矩阵控制，存量 grant 行读取时按未知 key 忽略。
      'course.create',
      'course.delete',
      'settings.employeeAccount',
      '',
      42,
      null,
    ]) {
      assert.equal(isFeatureKey(bad), false, String(bad));
    }
  });
});

describe('module level: environment ∩ role ∩ grant', () => {
  it('inherits the role matrix when there is no account switch', () => {
    assert.equal(
      effectiveMenuLevel('ADMIN', 'course', grants(), ALL_CAPABILITIES),
      'FULL',
    );
    assert.equal(
      effectiveMenuLevel(
        'GRAPHIC_DESIGNER',
        'course',
        grants(),
        ALL_CAPABILITIES,
      ),
      'EDIT',
    );
    assert.equal(
      effectiveMenuLevel(
        'COURSE_CREATOR',
        'course',
        grants(),
        ALL_CAPABILITIES,
      ),
      'VIEW',
    );
    assert.equal(
      effectiveMenuLevel(
        'OPERATION_ADMIN',
        'knowledge',
        grants(),
        ALL_CAPABILITIES,
      ),
      'NONE',
    );
  });

  it('a denied module switch tightens the role baseline to NONE', () => {
    assert.equal(
      effectiveModuleLevel(
        'ADMIN',
        'module.course',
        withGrant([['module.course', false]]),
        ALL_CAPABILITIES,
      ),
      'NONE',
    );
    assert.equal(
      effectiveMenuLevel(
        'ADMIN',
        'knowledge',
        withGrant([['module.knowledge', false]]),
        ALL_CAPABILITIES,
      ),
      'NONE',
    );
  });

  it('an allowed module switch lifts a role NONE to VIEW (never higher)', () => {
    assert.equal(
      effectiveModuleLevel(
        'OPERATION_ADMIN',
        'module.knowledge',
        withGrant([['module.knowledge', true]]),
        ALL_CAPABILITIES,
      ),
      'VIEW',
    );
    assert.equal(
      effectiveModuleLevel(
        'OPERATION_ADMIN',
        'module.ai',
        withGrant([['module.ai', true]]),
        ALL_CAPABILITIES,
      ),
      'VIEW',
    );
    // 已有更高基线时保留基线（VIEW 的开关不能让 EDIT 降级）
    assert.equal(
      effectiveModuleLevel(
        'GRAPHIC_DESIGNER',
        'module.course',
        withGrant([['module.course', true]]),
        ALL_CAPABILITIES,
      ),
      'EDIT',
    );
  });

  it('environment capability always wins over an allowed account switch', () => {
    const restricted = parseEnabledCapabilities('course,accounts');
    for (const [module, capability] of [
      ['module.knowledge', 'knowledge'],
      ['module.helpdesk', 'helpdesk'],
      ['module.students', 'students'],
      ['module.settings', 'settings'],
    ] as const) {
      assert.equal(
        effectiveModuleLevel(
          'ADMIN',
          module,
          withGrant([[module, true]]),
          restricted,
        ),
        'NONE',
        capability,
      );
    }
    assert.equal(
      effectiveModuleLevel('ADMIN', 'module.course', grants(), restricted),
      'FULL',
    );
    assert.equal(
      effectiveModuleLevel('ADMIN', 'module.accounts', grants(), restricted),
      'FULL',
    );
    const noAccounts = parseEnabledCapabilities('course');
    assert.equal(
      effectiveModuleLevel(
        'ADMIN',
        'module.accounts',
        withGrant([['module.accounts', true]]),
        noAccounts,
      ),
      'NONE',
    );
  });

  it('accounts is Admin baseline; grants can only remove it (PRD §3.3)', () => {
    assert.equal(
      effectiveModuleLevel(
        'ADMIN',
        'module.accounts',
        grants(),
        ALL_CAPABILITIES,
      ),
      'FULL',
    );
    assert.equal(
      effectiveModuleLevel(
        'FINANCE',
        'module.accounts',
        grants(),
        ALL_CAPABILITIES,
      ),
      'NONE',
    );
    // PRD §3.3 的硬边界：module 通用「允许可越过 NONE」不适用于 accounts
    assert.equal(
      effectiveModuleLevel(
        'FINANCE',
        'module.accounts',
        withGrant([['module.accounts', true]]),
        ALL_CAPABILITIES,
      ),
      'NONE',
    );
    assert.equal(
      effectiveModuleLevel(
        'ADMIN',
        'module.accounts',
        withGrant([['module.accounts', false]]),
        ALL_CAPABILITIES,
      ),
      'NONE',
    );
    assert.equal(
      effectiveModuleLevel(
        'ADMIN',
        'module.accounts',
        withGrant([['module.accounts', true]]),
        ALL_CAPABILITIES,
      ),
      'FULL',
    );
  });

  it('operations follows the Course baseline it lives inside', () => {
    assert.equal(
      effectiveModuleLevel(
        'ADMIN',
        'module.operations',
        grants(),
        ALL_CAPABILITIES,
      ),
      'FULL',
    );
    assert.equal(
      effectiveModuleLevel(
        'ADMIN',
        'module.operations',
        withGrant([['module.operations', false]]),
        ALL_CAPABILITIES,
      ),
      'NONE',
    );
  });
});

describe('course actions: role baseline overridden per action', () => {
  const level = (
    roleName: EmployeeRole,
    action: ActionKind,
    map: FeatureGrantMap = grants(),
  ) => effectiveCourseAction(roleName, action, map, ALL_CAPABILITIES);

  it('inherits the role action baseline by default', () => {
    assert.equal(level('ADMIN', 'VIEW'), true);
    assert.equal(level('ADMIN', 'EDIT_EXISTING'), true);
    assert.equal(level('ADMIN', 'CREATE'), true);
    assert.equal(level('ADMIN', 'DELETE'), true);
    assert.equal(level('ADMIN', 'PUBLISH'), true);
    assert.equal(level('ADMIN', 'IMPORT'), true);
    assert.equal(level('ADMIN', 'EXPORT'), true);

    assert.equal(level('GRAPHIC_DESIGNER', 'VIEW'), true);
    assert.equal(level('GRAPHIC_DESIGNER', 'EDIT_EXISTING'), true);
    assert.equal(level('GRAPHIC_DESIGNER', 'CREATE'), false);
    assert.equal(level('GRAPHIC_DESIGNER', 'DELETE'), false);
    assert.equal(level('GRAPHIC_DESIGNER', 'PUBLISH'), false);
    assert.equal(level('GRAPHIC_DESIGNER', 'IMPORT'), false);
    assert.equal(level('GRAPHIC_DESIGNER', 'EXPORT'), false);

    assert.equal(level('COURSE_CREATOR', 'VIEW'), true);
    assert.equal(level('COURSE_CREATOR', 'EDIT_EXISTING'), false);
  });

  it('an allowed action switch can exceed the role action baseline', () => {
    assert.equal(
      level(
        'GRAPHIC_DESIGNER',
        'PUBLISH',
        withGrant([['course.publish', true]]),
      ),
      true,
    );
    assert.equal(
      level(
        'COURSE_CREATOR',
        'EDIT_EXISTING',
        withGrant([['course.edit', true]]),
      ),
      true,
    );
    assert.equal(
      level('COURSE_CREATOR', 'IMPORT', withGrant([['course.import', true]])),
      true,
    );
    assert.equal(
      level('GRAPHIC_DESIGNER', 'EXPORT', withGrant([['course.export', true]])),
      true,
    );
  });

  it('a denied action switch tightens even an Admin', () => {
    assert.equal(
      level('ADMIN', 'PUBLISH', withGrant([['course.publish', false]])),
      false,
    );
    assert.equal(
      level('ADMIN', 'IMPORT', withGrant([['course.import', false]])),
      false,
    );
    assert.equal(
      level('ADMIN', 'VIEW', withGrant([['course.view', false]])),
      false,
    );
    // 只关发布，不影响编辑
    assert.equal(
      level('ADMIN', 'EDIT_EXISTING', withGrant([['course.publish', false]])),
      true,
    );
  });

  it('the independent switches do not leak into each other', () => {
    const importOnly = withGrant([['course.import', true]]);
    assert.equal(level('COURSE_CREATOR', 'IMPORT', importOnly), true);
    assert.equal(level('COURSE_CREATOR', 'EXPORT', importOnly), false);
    assert.equal(level('COURSE_CREATOR', 'PUBLISH', importOnly), false);

    const exportOnly = withGrant([['course.export', true]]);
    assert.equal(level('COURSE_CREATOR', 'EXPORT', exportOnly), true);
    assert.equal(level('COURSE_CREATOR', 'IMPORT', exportOnly), false);
  });

  it('create/delete are role-matrix only: no account switch grants or revokes them', () => {
    assert.equal(level('ADMIN', 'CREATE'), true);
    assert.equal(level('OPERATION_ADMIN', 'DELETE'), true);
    assert.equal(level('GRAPHIC_DESIGNER', 'CREATE'), false);
    assert.equal(level('GRAPHIC_DESIGNER', 'DELETE'), false);
    assert.equal(level('COURSE_CREATOR', 'CREATE'), false);
    assert.equal(level('COURSE_CREATOR', 'DELETE'), false);

    // 存量 grant 行（旧词表）读取时按未知 key 忽略：既不放大也不收紧角色矩阵。
    const stale = withGrant([
      ['course.create' as unknown as FeatureKey, true],
      ['course.delete' as unknown as FeatureKey, true],
    ]);
    assert.equal(level('GRAPHIC_DESIGNER', 'CREATE', stale), false);
    assert.equal(level('COURSE_CREATOR', 'DELETE', stale), false);
    const staleDeny = withGrant([
      ['course.create' as unknown as FeatureKey, false],
      ['course.delete' as unknown as FeatureKey, false],
    ]);
    assert.equal(level('ADMIN', 'CREATE', staleDeny), true);
    assert.equal(level('ADMIN', 'DELETE', staleDeny), true);
  });

  it('actions require the module itself to be visible', () => {
    const map = withGrant([
      ['module.course', false],
      ['course.publish', true],
    ]);
    assert.equal(level('ADMIN', 'PUBLISH', map), false);
    assert.equal(level('ADMIN', 'VIEW', map), false);
  });

  it('environment capability strips every course action', () => {
    const none = parseEnabledCapabilities('knowledge');
    assert.equal(
      effectiveCourseAction(
        'ADMIN',
        'PUBLISH',
        withGrant([['course.publish', true]]),
        none,
      ),
      false,
    );
  });
});

describe('menu action decision uses the resolved level', () => {
  it('grants VIEW on a menu the role cannot see, but keeps writes role-bound', () => {
    const map = withGrant([['module.knowledge', true]]);
    assert.equal(
      isMenuActionAllowed(
        'OPERATION_ADMIN',
        'knowledge',
        'VIEW',
        map,
        ALL_CAPABILITIES,
      ),
      true,
    );
    assert.equal(
      isMenuActionAllowed(
        'OPERATION_ADMIN',
        'knowledge',
        'EDIT_EXISTING',
        map,
        ALL_CAPABILITIES,
      ),
      false,
    );
  });

  it('keeps the existing role behaviour for non-course menus', () => {
    assert.equal(
      isMenuActionAllowed(
        'FINANCE',
        'order',
        'CREATE',
        grants(),
        ALL_CAPABILITIES,
      ),
      true,
    );
    assert.equal(
      isMenuActionAllowed(
        'FINANCE',
        'course',
        'EDIT_EXISTING',
        grants(),
        ALL_CAPABILITIES,
      ),
      false,
    );
  });

  it('module feature checks distinguish module switches from course actions', () => {
    assert.equal(
      isModuleFeatureAllowed(
        'module.operations',
        'ADMIN',
        withGrant([['module.operations', false]]),
        ALL_CAPABILITIES,
      ),
      false,
    );
    assert.equal(
      isModuleFeatureAllowed(
        'module.operations',
        'ADMIN',
        grants(),
        ALL_CAPABILITIES,
      ),
      true,
    );
  });
});

describe('resolveEffectiveFeatures', () => {
  it('reports every catalogue key with a resolved level and allowed flag', () => {
    const effective = resolveEffectiveFeatures({
      role: 'GRAPHIC_DESIGNER',
      grants: withGrant([
        ['module.knowledge', false],
        ['course.publish', true],
      ]),
      enabledCapabilities: ALL_CAPABILITIES,
    });
    assert.equal(effective.length, FEATURE_CATALOG.length);
    const byKey = new Map(effective.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get('module.knowledge')?.allowed, false);
    assert.equal(byKey.get('module.knowledge')?.level, 'NONE');
    assert.equal(byKey.get('module.course')?.level, 'EDIT');
    assert.equal(byKey.get('module.course')?.allowed, true);
    assert.equal(byKey.get('course.publish')?.allowed, true);
    assert.equal(byKey.get('course.publish')?.level, null);
    assert.equal(byKey.get('course.import')?.allowed, false);
  });

  it('never reports a key whose environment capability is disabled', () => {
    const effective = resolveEffectiveFeatures({
      role: 'ADMIN',
      grants: withGrant([
        ['module.helpdesk', true],
        ['module.knowledge', true],
        ['course.publish', true],
      ]),
      enabledCapabilities: parseEnabledCapabilities('course,accounts'),
    });
    const allowed = effective
      .filter((entry) => entry.allowed)
      .map((e) => e.key);
    assert.ok(!allowed.includes('module.helpdesk'));
    assert.ok(!allowed.includes('module.knowledge'));
    // course 能力在裁剪集里是开着的：动作开关照常生效
    assert.ok(allowed.includes('course.publish'));
    assert.ok(allowed.includes('module.course'));
    assert.ok(allowed.includes('module.accounts'));
    assert.deepEqual(
      allowed.filter((key) => key.startsWith('course.')),
      [
        'course.view',
        'course.edit',
        'course.publish',
        'course.import',
        'course.export',
      ],
    );
    // 新建/删除不在账号级目录里：不出现在 effective/catalog 行中
    assert.ok(!allowed.includes('course.create' as never));
    assert.ok(!allowed.includes('course.delete' as never));
  });
});

describe('角色基线展示与路由级课程动作判定', () => {
  it('resolveBaselineFeatures 忽略账号开关，只反映角色矩阵', () => {
    const baseline = new Map(
      resolveBaselineFeatures('GRAPHIC_DESIGNER').map((entry) => [
        entry.key,
        entry,
      ]),
    );
    assert.equal(baseline.get('module.course')?.level, 'EDIT');
    assert.equal(baseline.get('module.accounts')?.level, 'NONE');
    assert.equal(baseline.get('course.edit')?.allowed, true);
    assert.equal(baseline.get('course.publish')?.allowed, false);
    assert.equal(baseline.get('course.import')?.allowed, false);
  });

  it('isCourseActionFeatureAllowed 与 effectiveCourseAction 一致（可加可减）', () => {
    const caps = parseEnabledCapabilities('course,accounts');
    const granted = withGrant([
      ['course.import', true],
      ['course.publish', true],
    ]);
    assert.equal(
      isCourseActionFeatureAllowed(
        'course.import',
        'GRAPHIC_DESIGNER',
        granted,
        caps,
      ),
      true,
    );
    assert.equal(
      isCourseActionFeatureAllowed(
        'course.export',
        'GRAPHIC_DESIGNER',
        granted,
        caps,
      ),
      false,
    );
    const revoked = withGrant([['course.publish', false]]);
    assert.equal(
      isCourseActionFeatureAllowed('course.publish', 'ADMIN', revoked, caps),
      false,
    );
  });
});
