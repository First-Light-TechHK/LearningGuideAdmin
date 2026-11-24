// 账号级功能权限（角色基线 ± 账号开关）与菜单/设置子项过滤。
// 契约：GET/PUT /api/admin/employees/:id/features 返回 catalog + grants + effective；
// GET /api/session 的 features 是该员工生效的功能键集合（服务端 effective，前端不重算角色矩阵）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  featureDraftFromFeatures,
  setFeatureMode,
  featureGrantsPayload,
  effectiveFeatureMap,
  type EmployeeFeatures,
} from '../src/backoffice/contracts/employee'
import {
  ALL_CAPABILITIES,
  CAPABILITY_IDS,
  MENU_CAPABILITY,
  accountFeaturesFromSession,
  accountMenus,
  cachedAccountFeatures,
  capabilitiesForSegments,
  featureKeysForSegments,
  filterMenusByCapabilities,
  filterMenusByFeatures,
  landingMenuFor,
  rememberAccountFeatures,
  type CapabilityId,
} from '../src/backoffice/lib/capabilities'
import { MENU_ORDER, visibleMenus, visibleSettingsSubs } from '../src/backoffice/rbac/permissions'

const caps = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids)
const featuresOf = (...keys: string[]) => new Set(keys)

function sampleFeatures(): EmployeeFeatures {
  return {
    employeeId: 'e1',
    catalog: [
      { key: 'module.course', group: 'module', sortOrder: 1 },
      { key: 'module.accounts', group: 'module', sortOrder: 2 },
      { key: 'course.edit', group: 'course', sortOrder: 3 },
      { key: 'course.publish', group: 'course', sortOrder: 4 },
    ],
    grants: [
      { feature: 'course.edit', allowed: true },
      { feature: 'course.publish', allowed: false },
    ],
    effective: [
      { key: 'module.course', allowed: true, level: 'FULL' },
      { key: 'module.accounts', allowed: true, level: 'FULL' },
      { key: 'course.edit', allowed: true, level: 'EDIT' },
      { key: 'course.publish', allowed: false, level: 'NONE' },
    ],
  }
}

test('三态草稿：显式 grants → 允许/禁止，未出现的 key → 继承角色', () => {
  const draft = featureDraftFromFeatures(sampleFeatures())
  assert.deepEqual(draft, {
    'module.course': 'INHERIT',
    'module.accounts': 'INHERIT',
    'course.edit': 'ALLOW',
    'course.publish': 'DENY',
  })
  // 目录为空 / 数据缺失时给空草稿，不崩
  assert.deepEqual(featureDraftFromFeatures(null), {})
  assert.deepEqual(
    featureDraftFromFeatures({ employeeId: 'e', catalog: [], grants: [], effective: [] }),
    {},
  )
})

test('三态状态机：单键在 继承/允许/禁止 间切换，不改其它键也不改原对象', () => {
  const start = featureDraftFromFeatures(sampleFeatures())
  const toAllow = setFeatureMode(start, 'module.course', 'ALLOW')
  assert.equal(toAllow['module.course'], 'ALLOW')
  assert.equal(toAllow['course.edit'], 'ALLOW')
  assert.equal(start['module.course'], 'INHERIT')
  const toDeny = setFeatureMode(toAllow, 'module.course', 'DENY')
  assert.equal(toDeny['module.course'], 'DENY')
  const back = setFeatureMode(toDeny, 'module.course', 'INHERIT')
  assert.equal(back['module.course'], 'INHERIT')
  // 未知 key 也允许编辑（目录由服务端给，前端不硬编码 key 集合）
  assert.equal(setFeatureMode(start, 'future.feature', 'ALLOW')['future.feature'], 'ALLOW')
})

test('保存载荷：只发显式 允许/禁止，继承 = 省略（替换式 PUT 即幂等清空）', () => {
  const data = sampleFeatures()
  const draft = {
    'course.publish': 'DENY',
    'module.course': 'ALLOW',
    'module.accounts': 'INHERIT',
    'course.edit': 'INHERIT',
  } as const
  const payload = featureGrantsPayload(draft, data.catalog)
  // 按目录 sortOrder 稳定排序，同输入同输出
  assert.deepEqual(payload, {
    grants: [
      { feature: 'module.course', allowed: true },
      { feature: 'course.publish', allowed: false },
    ],
  })
  // 全部继承 = 空数组 = 清空该账号所有显式开关
  const allInherit = Object.fromEntries(
    data.catalog.map((entry) => [entry.key, 'INHERIT' as const]),
  )
  assert.deepEqual(featureGrantsPayload(allInherit, data.catalog), {
    grants: [],
  })
})

test('生效结果只读服务端 effective：缺失 key 不臆造', () => {
  const map = effectiveFeatureMap(sampleFeatures().effective)
  assert.equal(map['module.course'], true)
  assert.equal(map['course.publish'], false)
  assert.equal(map['course.import'], undefined)
  assert.deepEqual(effectiveFeatureMap(null), {})
})

test('session features 解析：缺失/非数组 = 旧服务端（不限制），空数组 = 全部无权限', () => {
  for (const payload of [null, undefined, {}, { features: undefined }, { features: 'module.course' }, { features: 42 }]) {
    assert.equal(accountFeaturesFromSession(payload as never), null)
  }
  assert.deepEqual(accountFeaturesFromSession({ features: [] }), new Set())
  assert.deepEqual(
    accountFeaturesFromSession({ features: ['module.course', 42, 'course.view'] }),
    featuresOf('module.course', 'course.view'),
  )
})

test('能力门：CAPABILITY_IDS 增 accounts；settings 菜单在 settings 或 accounts 下都可见', () => {
  assert.ok((CAPABILITY_IDS as readonly string[]).includes('accounts'))
  assert.deepEqual(MENU_CAPABILITY.settings, ['settings', 'accounts'])
  const adminMenus = visibleMenus('ADMIN')
  const courseAndAccounts = filterMenusByCapabilities(adminMenus, caps('course', 'accounts'))
  assert.ok(courseAndAccounts.includes('settings'))
  assert.ok(!courseAndAccounts.includes('knowledge'))
})

test('菜单 = 角色 ∩ 环境能力 ∩ 账号 module.*：账号禁止的模块隐藏，允许可越过角色 NONE', () => {
  const roleMenus = filterMenusByCapabilities(visibleMenus('ADMIN'), ALL_CAPABILITIES)
  // 账号禁止 knowledge / ai
  const restricted = filterMenusByFeatures(
    roleMenus,
    featuresOf('module.course', 'course.view', 'module.settings', 'module.accounts'),
  )
  assert.deepEqual(restricted, ['course', 'settings'])
  // 只保留 module.accounts：settings 菜单仍可见（账号管理独立能力），其余隐藏
  assert.deepEqual(filterMenusByFeatures(roleMenus, featuresOf('module.accounts')), ['settings'])
  // 旧服务端 / 尚未返回 features = 不额外限制
  assert.deepEqual(filterMenusByFeatures(roleMenus, null), roleMenus)
  // 账号开关可给 OPERATION_ADMIN 越过角色 NONE 打开 knowledge（服务端 effective 已判定，前端以 features 为准）
  const operation = visibleMenus('OPERATION_ADMIN')
  assert.ok(!operation.includes('knowledge'))
  assert.ok(
    accountMenus(operation, featuresOf('module.course', 'course.view', 'module.knowledge', 'module.settings', 'module.accounts', 'module.order', 'module.reporting', 'module.students', 'module.helpdesk')).includes('knowledge'),
  )
  // 旧服务端（features 缺失）仍按角色菜单，不会因为 grants 未知而放开
  assert.deepEqual(accountMenus(operation, null), operation)
})

test('路由归属：settings 子项分辨 accounts / settings，其余菜单按 module 键', () => {
  assert.deepEqual(capabilitiesForSegments(['settings', 'employee-account']), ['settings', 'accounts'])
  assert.deepEqual(capabilitiesForSegments(['settings', 'learning-access']), ['settings'])
  assert.deepEqual(capabilitiesForSegments(['settings']), ['settings', 'accounts'])
  assert.deepEqual(capabilitiesForSegments(['course', 'c1']), ['course'])
  assert.deepEqual(capabilitiesForSegments(['help-desk', 't1']), ['helpdesk'])
  assert.equal(capabilitiesForSegments([]), null)
  assert.equal(capabilitiesForSegments(['unknown']), null)

  assert.deepEqual(featureKeysForSegments(['settings', 'employee-account']), ['module.accounts'])
  assert.deepEqual(featureKeysForSegments(['settings', 'payment-gateway']), ['module.settings'])
  assert.deepEqual(featureKeysForSegments(['settings']), ['module.settings', 'module.accounts'])
  assert.deepEqual(featureKeysForSegments(['course', 'c1']), ['module.course', 'course.view'])
  assert.deepEqual(featureKeysForSegments(['student']), ['module.students'])
  assert.equal(featureKeysForSegments([]), null)
})

test('落点菜单同时满足环境能力与账号功能', () => {
  const admin = visibleMenus('ADMIN')
  assert.equal(landingMenuFor(admin, caps('course', 'accounts'), featuresOf('module.accounts')), 'settings')
  assert.equal(landingMenuFor(admin, caps('course', 'accounts'), featuresOf('module.course', 'course.view', 'module.accounts')), 'course')
  assert.equal(landingMenuFor(admin, caps('course'), featuresOf('module.settings')), null)
  assert.equal(landingMenuFor(admin, caps('knowledge'), null), 'knowledge')
})

test('Settings 子项：employeeAccount 要 module.accounts，其余要 module.settings，且非 Admin 永不可见', () => {
  // Sandbox 形态：环境只有 accounts，账号只有 module.accounts → 只剩员工账号子项
  assert.deepEqual(
    visibleSettingsSubs('ADMIN', caps('accounts'), featuresOf('module.accounts')),
    ['employeeAccount'],
  )
  // 环境 settings 开、账号 module.settings 开 → 其余子项回来，employeeAccount 仍被 module.accounts 关掉
  assert.deepEqual(
    visibleSettingsSubs('ADMIN', caps('settings'), featuresOf('module.settings')),
    ['paymentGateway', 'notificationConfiguration', 'learningAccess'],
  )
  // 全开（旧调用只传 role）保持原行为
  assert.deepEqual(visibleSettingsSubs('ADMIN'), [
    'employeeAccount',
    'paymentGateway',
    'notificationConfiguration',
    'learningAccess',
  ])
  // 非 Admin 即使被错误地给了 module.accounts 也看不到员工账号
  assert.deepEqual(
    visibleSettingsSubs('COURSE_CREATOR', caps('settings', 'accounts'), featuresOf('module.settings', 'module.accounts')),
    ['paymentGateway', 'notificationConfiguration', 'learningAccess'],
  )
  // Settings 首页落点按过滤后的第一个子项
  assert.equal(visibleSettingsSubs('ADMIN', caps('accounts'), featuresOf('module.accounts'))[0], 'employeeAccount')
  assert.equal(visibleSettingsSubs('ADMIN', caps('settings'), featuresOf('module.settings'))[0], 'paymentGateway')
})

test('session 级缓存：ShellRoute 记住后子导航同步读取，缺省 = 不限制', () => {
  assert.equal(cachedAccountFeatures(), null)
  rememberAccountFeatures({ features: ['module.course'] })
  assert.deepEqual(cachedAccountFeatures(), featuresOf('module.course'))
  rememberAccountFeatures({ features: undefined })
  assert.equal(cachedAccountFeatures(), null)
  // MENU_ORDER 全部有 module 键映射，新增菜单必须来登记
  for (const menu of MENU_ORDER) assert.ok(MENU_CAPABILITY[menu]?.length, menu)
})
