// 能力门（ADMIN_CAPABILITIES）前端单测：解析、菜单交集、路由归属与落点。
// 服务端同名能力集见 server/src/common/capabilities.ts；字段缺失 = 全开（旧服务端兼容）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALL_CAPABILITIES,
  CAPABILITY_IDS,
  DEFAULT_PREVIEW_ENTRY,
  MENU_CAPABILITY,
  cachedCapabilities,
  cachedPreviewEntry,
  capabilitiesForSegments,
  capabilitiesFromEnvironment,
  filterMenusByCapabilities,
  landingMenuFor,
  previewEntryFromEnvironment,
  rememberEnvironment,
  type CapabilityId,
} from '../src/backoffice/lib/capabilities'
import { MENU_ORDER, visibleMenus } from '../src/backoffice/rbac/permissions'

const set = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids)

test('字段缺失 / 非数组 / 读取失败 = 全开（旧服务端兼容）', () => {
  for (const payload of [
    null,
    undefined,
    {},
    { capabilities: undefined },
    { capabilities: 'course' },
    { capabilities: 42 },
  ]) {
    const enabled = capabilitiesFromEnvironment(payload as never)
    assert.equal(enabled.size, CAPABILITY_IDS.length)
    assert.deepEqual(enabled, ALL_CAPABILITIES)
  }
})

test('解析子集：只认已知能力标识，未知值忽略', () => {
  assert.deepEqual(
    capabilitiesFromEnvironment({ capabilities: ['course'] }),
    set('course'),
  )
  assert.deepEqual(
    capabilitiesFromEnvironment({ capabilities: ['course', 'helpdesk'] }),
    set('course', 'helpdesk'),
  )
  // 未来服务端新增能力名时，老前端忽略它而不是整份失效
  assert.deepEqual(
    capabilitiesFromEnvironment({ capabilities: ['course', 'future-module'] }),
    set('course'),
  )
})

test('菜单 = 角色可见菜单 ∩ 已启用能力，PORT-NAV-002 顺序不变', () => {
  const adminMenus = visibleMenus('ADMIN')
  assert.deepEqual(
    filterMenusByCapabilities(adminMenus, ALL_CAPABILITIES),
    adminMenus,
  )
  assert.deepEqual(filterMenusByCapabilities(adminMenus, set('course')), [
    'course',
  ])
  assert.deepEqual(
    filterMenusByCapabilities(adminMenus, set('helpdesk', 'course')),
    ['course', 'helpDesk'],
  )
  // RBAC 继续生效：OPERATION_ADMIN 本来就看不了 Knowledge / AI Tutor，能力全开也不会出现
  const operationAdmin = filterMenusByCapabilities(
    visibleMenus('OPERATION_ADMIN'),
    ALL_CAPABILITIES,
  )
  assert.equal(operationAdmin.includes('knowledge'), false)
  assert.equal(operationAdmin.includes('aiTutor'), false)
})

test('每个菜单都有对应能力（新增菜单必须来登记）', () => {
  for (const menu of MENU_ORDER) {
    assert.ok(MENU_CAPABILITY[menu]?.length, menu)
  }
  assert.equal(Object.keys(MENU_CAPABILITY).length, MENU_ORDER.length)
  // settings 可由 settings 或 accounts 任一能力打开（Sandbox 只开 accounts）
  assert.deepEqual(MENU_CAPABILITY.settings, ['settings', 'accounts'])
  // 能力标识与服务端保持同一套
  assert.deepEqual(
    [...CAPABILITY_IDS],
    [
      'course',
      'knowledge',
      'ai',
      'students',
      'helpdesk',
      'operations',
      'reporting',
      'order',
      'settings',
      'accounts',
    ],
  )
})

test('路由第一段 → 能力；未登记路由不参与能力重定向', () => {
  assert.deepEqual(capabilitiesForSegments(['course', 'c1', 'preview']), ['course'])
  assert.deepEqual(capabilitiesForSegments(['operations']), ['operations'])
  assert.deepEqual(capabilitiesForSegments(['knowledge']), ['knowledge'])
  assert.deepEqual(capabilitiesForSegments(['ai-tutor']), ['ai'])
  assert.deepEqual(capabilitiesForSegments(['order']), ['order'])
  assert.deepEqual(capabilitiesForSegments(['reporting']), ['reporting'])
  assert.deepEqual(capabilitiesForSegments(['student']), ['students'])
  assert.deepEqual(capabilitiesForSegments(['help-desk', 't1']), ['helpdesk'])
  // accounts 能力只覆盖员工账号子页；其它 Settings 子项仍要 settings
  assert.deepEqual(capabilitiesForSegments(['settings', 'employee-account']), ['settings', 'accounts'])
  assert.deepEqual(capabilitiesForSegments(['settings', 'learning-access']), ['settings'])
  assert.deepEqual(capabilitiesForSegments(['settings']), ['settings', 'accounts'])
  assert.equal(capabilitiesForSegments([]), null)
  assert.equal(capabilitiesForSegments(undefined), null)
  assert.equal(capabilitiesForSegments(['unknown']), null)
})

test('禁用路由的落点：角色可见且能力启用的第一个菜单，否则 null', () => {
  assert.equal(landingMenuFor(visibleMenus('ADMIN'), set('course')), 'course')
  assert.equal(
    landingMenuFor(visibleMenus('ADMIN'), set('knowledge')),
    'knowledge',
  )
  assert.equal(landingMenuFor(visibleMenus('ADMIN'), set()), null)
})

test('PREVIEW_ENTRY 解析：只认 portal，缺失 / 未知值 = learner（旧服务端与上游缺省）', () => {
  assert.equal(DEFAULT_PREVIEW_ENTRY, 'learner')
  for (const payload of [
    null,
    undefined,
    {},
    { previewEntry: undefined },
    { previewEntry: 'learner' },
    { previewEntry: 'qa' },
    { previewEntry: 42 },
  ]) {
    assert.equal(previewEntryFromEnvironment(payload as never), 'learner')
  }
  assert.equal(previewEntryFromEnvironment({ previewEntry: 'portal' }), 'portal')
  // 服务端配置大小写/空白不敏感，前端同样宽容
  assert.equal(previewEntryFromEnvironment({ previewEntry: ' Portal ' }), 'portal')
})

test('环境端点模块级缓存：ShellRoute 记住后页面同步读取，缺省 = 全开 + learner', () => {
  // 初始（尚未拉环境端点 / 旧服务端）= 全开 + learner
  assert.deepEqual(cachedCapabilities(), ALL_CAPABILITIES)
  assert.equal(cachedPreviewEntry(), 'learner')
  // ShellRoute 拉到环境端点后写入：能力集与预览入口一次解析
  rememberEnvironment({ capabilities: ['course'], previewEntry: 'portal' })
  assert.deepEqual(cachedCapabilities(), set('course'))
  assert.equal(cachedPreviewEntry(), 'portal')
  // 读取失败 / 旧服务端：覆盖为全开 + learner，与 capabilitiesFromEnvironment 同语义
  rememberEnvironment(null)
  assert.deepEqual(cachedCapabilities(), ALL_CAPABILITIES)
  assert.equal(cachedPreviewEntry(), 'learner')
  // 字段缺失但其它字段存在时同样回退缺省
  rememberEnvironment({ previewEntry: 'portal' })
  assert.deepEqual(cachedCapabilities(), ALL_CAPABILITIES)
  rememberEnvironment({})
  assert.equal(cachedPreviewEntry(), 'learner')
})
