// 发布动效：减少动效 / 没有 Element.animate 时不跑 WAAPI，只淡入，data-publish-motion 直接到 done，新线上行可见。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'

import { EmployeeContext } from '../src/backoffice/employeeSession'
import { rememberAccountFeatures, rememberEnvironment } from '../src/backoffice/lib/capabilities'
import { CourseVersionsSection } from '../src/backoffice/pages/course-editor/CourseVersionsSection'
import { employee, installFakeServer } from './support/helpdesk-fake'

const COURSE = {
  id: 'c1', code: 'C1', hasDraft: true, liveStatus: 'ONLINE', learningLanguages: ['en-GB'], defaultContentLanguage: 'en-GB',
  localizations: [], lessons: [],
  completeness: {
    completedSteps: 3, canPublish: true, publishBlockerCodes: [], incompleteLessons: [],
    steps: { courseInformation: { complete: true, missing: [] }, content: { complete: true, missing: [] }, trial: { complete: true, missing: [] } },
  },
} as never

const version = (no: number, label: string, isLive: boolean) => ({
  id: `v${no}`, versionNo: no, versionLabel: label, versionSeries: 1, versionMinor: no, sourceEnvironment: null, sourceVersionLabel: null,
  wentLiveAt: '2026-11-20T10:00:00.000Z', publishedBy: 'olive', exportedAt: null, createdAt: '2026-11-20T10:00:00.000Z', isLive,
})

function Harness() {
  const [versions, setVersions] = useState([version(1, '1.1', true)])
  const [hasDraft, setHasDraft] = useState(true)
  return (
    <MemoryRouter>
      <EmployeeContext.Provider value={employee('ADMIN')}>
        <CourseVersionsSection
          locale="en-GB"
          course={{ ...(COURSE as object), hasDraft } as never}
          versions={versions as never}
          history={null}
          historyPage={1}
          setHistoryPage={() => {}}
          busy={false}
          setBusy={() => {}}
          onReload={async () => {
            setVersions([version(2, '1.2', true), version(1, '1.1', false)])
            setHasDraft(false)
          }}
          onNotice={() => {}}
        />
      </EmployeeContext.Provider>
    </MemoryRouter>
  )
}

const proto = (globalThis as { Element?: { prototype: { animate?: unknown } } }).Element?.prototype
let animateCalls = 0
let savedAnimate: unknown
let savedMatchMedia: unknown

beforeEach(() => {
  rememberEnvironment({ versionNumberingMode: 'sandbox' })
  rememberAccountFeatures({ features: ['module.course', 'course.view', 'course.publish'] })
  animateCalls = 0
  savedAnimate = proto?.animate
  savedMatchMedia = (window as { matchMedia?: unknown }).matchMedia
})

afterEach(() => {
  cleanup()
  rememberEnvironment(null)
  rememberAccountFeatures({})
  if (proto) proto.animate = savedAnimate
  ;(window as { matchMedia?: unknown }).matchMedia = savedMatchMedia
})

async function publishThroughDialog() {
  const server = installFakeServer()
  server.on('POST', '/api/backoffice/courses/c1/publish', { data: { ok: true } })
  try {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('publish-open'))
    const dialog = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Publish')!)
    })
    await waitFor(() => assert.ok(screen.getByTestId('version-row-v2')))
  } finally {
    server.restore()
  }
}

test('reduced motion: no animate call, motion ends done, new live row visible', async () => {
  ;(window as { matchMedia?: unknown }).matchMedia = () => ({ matches: true })
  if (proto) proto.animate = () => { animateCalls += 1; return {} }
  await publishThroughDialog()
  await waitFor(() => assert.equal(document.querySelector('.course-ui-vGrid')?.getAttribute('data-publish-motion'), 'done'))
  assert.equal(animateCalls, 0)
  assert.ok(screen.getByTestId('version-row-v2'))
})

test('no Element.animate (jsdom): same result, no throw', async () => {
  ;(window as { matchMedia?: unknown }).matchMedia = () => ({ matches: false })
  if (proto) proto.animate = undefined
  await publishThroughDialog()
  await waitFor(() => assert.equal(document.querySelector('.course-ui-vGrid')?.getAttribute('data-publish-motion'), 'done'))
  assert.ok(screen.getByTestId('version-row-v2'))
})
