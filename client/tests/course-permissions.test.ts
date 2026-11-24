// H1 / M1：课程动作按服务端 effective features 逐项判定；旧服务端回退角色矩阵。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  courseActionAllowed,
  featureRequirementForSegments,
  menuEffectiveLevel,
  menuFeatureAllowed,
} from '../src/backoffice/lib/capabilities'
import { coursePermissions } from '../src/backoffice/lib/coursePermissions'
import { buildAccess } from '../src/backoffice/lib/workspaceAccessState'

const GRANTS = new Set([
  'module.course',
  'course.view',
  'course.import',
  'course.publish',
])

test('账号级课程动作可越过角色基线（GRAPHIC_DESIGNER 获授 import/publish）', () => {
  assert.equal(courseActionAllowed('GRAPHIC_DESIGNER', 'IMPORT', GRANTS), true)
  assert.equal(courseActionAllowed('GRAPHIC_DESIGNER', 'PUBLISH', GRANTS), true)
  // 未显式授予的动作仍按角色基线（Edit 不能创建/删除）
  assert.equal(courseActionAllowed('GRAPHIC_DESIGNER', 'CREATE', GRANTS), false)
  assert.equal(courseActionAllowed('GRAPHIC_DESIGNER', 'DELETE', GRANTS), false)
  // 账号拒绝优先于角色基线（Admin 被收回 publish）
  assert.equal(
    courseActionAllowed('ADMIN', 'PUBLISH', new Set(['module.course', 'course.view'])),
    false,
  )
})

test('新建/删除不开放账号级开关：features 非空时仍按角色矩阵', () => {
  // 服务端 catalog 不再下发 course.create/delete，ADMIN 与 OPERATION_ADMIN 仍可建/删
  const features = new Set([
    'module.course',
    'course.view',
    'course.edit',
    'course.publish',
    'course.import',
    'course.export',
  ])
  assert.equal(courseActionAllowed('ADMIN', 'CREATE', features), true)
  assert.equal(courseActionAllowed('ADMIN', 'DELETE', features), true)
  assert.equal(courseActionAllowed('OPERATION_ADMIN', 'CREATE', features), true)
  assert.equal(courseActionAllowed('COURSE_CREATOR', 'CREATE', features), false)
})

test('旧服务端（features=null）课程动作回退角色矩阵', () => {
  assert.equal(courseActionAllowed('ADMIN', 'IMPORT', null), true)
  assert.equal(courseActionAllowed('GRAPHIC_DESIGNER', 'IMPORT', null), false)
  const permissions = coursePermissions('COURSE_CREATOR', null)
  assert.equal(permissions.view, true)
  assert.equal(permissions.edit, false)
  assert.equal(permissions.create, false)
})

test('course 菜单同时要求 module.course 与 course.view；其它模块任一命中', () => {
  assert.equal(menuFeatureAllowed('course', new Set(['module.course'])), false)
  assert.equal(
    menuFeatureAllowed('course', new Set(['module.course', 'course.view'])),
    true,
  )
  assert.equal(menuFeatureAllowed('knowledge', new Set(['module.knowledge'])), true)
  assert.equal(menuFeatureAllowed('knowledge', new Set(['module.course'])), false)
  // 旧服务端不额外限制
  assert.equal(menuFeatureAllowed('course', null), true)
})

test('路由要求：course 需要 allOf，settings 仍是 anyOf', () => {
  assert.deepEqual(featureRequirementForSegments(['course']), {
    allOf: ['module.course', 'course.view'],
    anyOf: [],
  })
  assert.deepEqual(featureRequirementForSegments(['settings']), {
    allOf: [],
    anyOf: ['module.settings', 'module.accounts'],
  })
})

test('工作区：账号允许把角色 NONE 抬到 VIEW，拒绝收紧到 NONE', () => {
  assert.equal(
    menuEffectiveLevel('OPERATION_ADMIN', 'knowledge', new Set(['module.knowledge'])),
    'VIEW',
  )
  assert.equal(
    menuEffectiveLevel('OPERATION_ADMIN', 'knowledge', new Set(['module.course'])),
    'NONE',
  )
  // 角色基线更高时保留基线（ADMIN knowledge=FULL）
  assert.equal(
    menuEffectiveLevel('ADMIN', 'knowledge', new Set(['module.knowledge'])),
    'FULL',
  )
  const access = buildAccess('OPERATION_ADMIN', 'knowledge', new Set(['module.knowledge']))
  assert.equal(access.level, 'VIEW')
  assert.equal(access.readOnly, true)
  assert.equal(access.canEdit, false)
  assert.equal(access.canCreate, false)
})
