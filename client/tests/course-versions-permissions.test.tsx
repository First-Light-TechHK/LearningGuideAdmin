// H1 / MEDIUM-1：版本区按钮按账号级 course.* 判定；导出只有线上版本；
// 版本表显示 Exported、来源与发布人。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { EmployeeContext } from '../src/backoffice/employeeSession'
import { rememberAccountFeatures, rememberEnvironment } from '../src/backoffice/lib/capabilities'
import { CourseVersionsSection } from '../src/backoffice/pages/course-editor/CourseVersionsSection'
import { employee } from './support/helpdesk-fake'

beforeEach(() => {
  rememberEnvironment({ versionNumberingMode: 'sandbox' })
})

afterEach(() => {
  cleanup()
  rememberAccountFeatures({})
  rememberEnvironment(null)
})

const COURSE = {
  id: 'c1',
  code: 'C1',
  hasDraft: true,
  liveStatus: 'ONLINE',
  learningLanguages: ['en-GB'],
  defaultContentLanguage: 'en-GB',
  localizations: [],
  lessons: [],
  completeness: {
    completedSteps: 3,
    canPublish: true,
    publishBlockerCodes: [],
    incompleteLessons: [],
    steps: {
      courseInformation: { complete: true, missing: [] },
      content: { complete: true, missing: [] },
      trial: { complete: true, missing: [] },
    },
  },
} as never

const VERSIONS = [
  {
    id: 'v2',
    versionNo: 2,
    versionLabel: '1.2',
    versionSeries: 1,
    versionMinor: 2,
    sourceEnvironment: 'Sandbox',
    sourceVersionLabel: '1.1',
    wentLiveAt: '2026-11-20T10:00:00.000Z',
    publishedBy: 'olive',
    exportedAt: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    isLive: true,
  },
  {
    id: 'v1',
    versionNo: 1,
    versionLabel: '1.1',
    versionSeries: 1,
    versionMinor: 1,
    sourceEnvironment: null,
    sourceVersionLabel: '1.0',
    wentLiveAt: '2026-11-19T10:00:00.000Z',
    publishedBy: 'System',
    exportedAt: '2026-11-20T11:00:00.000Z',
    createdAt: '2026-11-19T10:00:00.000Z',
    isLive: false,
  },
] as never

function renderVersions(
  role: Parameters<typeof employee>[0],
  options: { course?: unknown; versions?: unknown; locale?: string } = {},
) {
  return render(
    <MemoryRouter>
      <EmployeeContext.Provider value={employee(role)}>
        <CourseVersionsSection
          locale={options.locale ?? 'en-GB'}
          course={(options.course ?? COURSE) as never}
          versions={(options.versions ?? VERSIONS) as never}
          history={null}
          historyPage={1}
          setHistoryPage={() => {}}
          busy={false}
          setBusy={() => {}}
          onReload={async () => {}}
          onNotice={() => {}}
        />
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )
}

test('GRAPHIC_DESIGNER 被授予 course.publish：发布按钮出现（账号开关可越过角色基线）', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.publish'] })
  renderVersions('GRAPHIC_DESIGNER')
  assert.ok(screen.getByTestId('publish-open'))
  // 未授予 import/export：对应按钮不渲染
  assert.equal(screen.queryByText('Import package'), null)
  assert.equal(screen.queryByTestId('export-open'), null)
})

test('Admin 被收回 course.publish：发布/删草稿隐藏；有 course.export 时才显示导出', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.export'] })
  renderVersions('ADMIN')
  assert.equal(screen.queryByTestId('publish-open'), null)
  assert.equal(screen.queryByText('Delete draft'), null)
  assert.ok(screen.getByTestId('export-open'))
})

test('导出只有线上版本：没有 Working 选项，确认弹窗写明文件名', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.export'] })
  renderVersions('ADMIN')
  fireEvent.click(screen.getByTestId('export-open'))
  assert.equal(screen.queryByText('Working'), null)
  assert.ok(screen.getByText(/Export Version 1\.2\?/))
  assert.ok(screen.getByText(/C1_1\.2\.zip/))
  assert.ok(screen.getByTestId('export-confirm'))
  assert.ok(screen.getByRole('dialog'))
  // 沙盒、未导出：提示导出后的下一个号
  assert.ok(screen.getByText(/After the export, the next publish here starts Version 2\.1\./))
})

test('版本表按 PRD §15.5 显示 Exported、Sandbox 来源与发布人（列表常显，无需切段）', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view'] })
  renderVersions('ADMIN')
  assert.ok(screen.getByText('Sandbox 1.1'))
  assert.ok(screen.getByText('Restored from Version 1.0'))
  assert.ok(screen.getByText('olive'))
  // 导出过的版本在 Source 里写出日期；没有来源也没导出的才是破折号
  assert.match(screen.getByTestId('version-exported-v1').textContent ?? '', /^Exported /)
  assert.equal(screen.queryByTestId('version-exported-v2'), null)
})

test('草稿板写明将发布的版本号，下一次发布行与灯', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.publish'] })
  renderVersions('ADMIN')
  assert.match(screen.getByTestId('versions-publishes-as').textContent ?? '', /Publishes as Version 1\.3/)
  assert.ok(screen.getByTestId('version-next'))
  assert.match(screen.getByTestId('versions-numbering').textContent ?? '', /Numbers are automatic\. The next publish is Version 1\.3\./)
  assert.equal(document.querySelector('.course-ui-vTable .course-ui-node.isLamp')?.classList.contains('isUnlit'), false)
})

test('没有草稿：发布 / 删除草稿保持可聚焦并说明原因，没有下一次发布行', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.publish'] })
  renderVersions('ADMIN', { course: { ...(COURSE as object), hasDraft: false } })
  const publish = screen.getByTestId('publish-open')
  assert.equal(publish.getAttribute('aria-disabled'), 'true')
  assert.equal(publish.hasAttribute('disabled'), false)
  assert.equal(document.getElementById(publish.getAttribute('aria-describedby') ?? '')?.textContent, 'No draft')
  assert.equal(screen.queryByTestId('version-next'), null)
  assert.ok(screen.getByText(/The next publish will be/))
  fireEvent.click(publish)
  assert.equal(screen.queryByRole('dialog'), null)
})

test('线上课程为 Offline 时灯不亮', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view'] })
  renderVersions('ADMIN', { course: { ...(COURSE as object), liveStatus: 'OFFLINE' } })
  assert.equal(document.querySelector('.course-ui-vTable .course-ui-node.isLamp')?.classList.contains('isUnlit'), true)
})

test('发布确认：标题带版本号，取消在前、发布在后，对话框有 role', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.publish'] })
  renderVersions('ADMIN')
  fireEvent.click(screen.getByTestId('publish-open'))
  assert.ok(screen.getByText('Publish as Version 1.3?'))
  assert.ok(screen.getByRole('dialog'))
  const foot = document.querySelector('.course-ui-dFoot') as HTMLElement
  const labels = Array.from(foot.querySelectorAll('button')).map((button) => button.textContent)
  assert.deepEqual(labels, ['Cancel', 'Publish'])
  assert.ok(screen.getByText(/becomes the live version on this website straight away/))
})

test('第一次发布：说明课程以 Offline 开始', () => {
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.publish'] })
  renderVersions('ADMIN', { versions: [] })
  fireEvent.click(screen.getByTestId('publish-open'))
  assert.ok(screen.getByText('Publish as Version 1.1?'))
  assert.ok(screen.getByText(/becomes the first live version\. The course starts Offline/))
  assert.equal(screen.queryByText('Replaces'), null)
})

test('版本号未知（环境端点没读到）：不预测号码', () => {
  rememberEnvironment(null)
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.publish'] })
  renderVersions('ADMIN')
  assert.equal(screen.queryByTestId('versions-publishes-as'), null)
  assert.equal(screen.queryByTestId('version-next'), null)
  fireEvent.click(screen.getByTestId('publish-open'))
  assert.ok(screen.getByText('Publish this draft?'))
})
