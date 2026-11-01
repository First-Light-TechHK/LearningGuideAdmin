import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { emptyFaqDraft, type FaqDraft } from '../src/backoffice/lib/helpdeskFaqs'
import {
  aiHistory,
  changedFields,
  cleanSelection,
  currentVersion,
  editHistory,
  goTo,
  rebase,
  startHistory,
} from '../src/backoffice/lib/helpdeskVersions'

/** 卡片内容的版本（像 Claude Artifact）：AI 改一次一个版本，人手连续输入并成一个。 */

const base = (patch: Partial<FaqDraft> = {}): FaqDraft => ({
  ...emptyFaqDraft(),
  questionZh: '退款需要多久？',
  answerZh: '3 个工作日。',
  questionEn: 'How long?',
  answerEn: '3 working days.',
  ...patch,
})

describe('card versions', () => {
  test('typing in a row is one manual version; an AI change is a new version with the changed fields', () => {
    let history = startHistory(base())
    history = editHistory(history, { answerZh: '3 个工作日内。' })
    history = editHistory(history, { answerZh: '3 个工作日内处理。' })
    assert.equal(history.versions.length, 2)
    assert.equal(currentVersion(history).origin, 'manual')
    assert.deepEqual(currentVersion(history).changed, ['answerZh'])
    const next = aiHistory(history, { answerZh: '一般 3 个工作日。', answerEn: 'Usually 3 working days.' }, '短一点')
    assert.ok(next)
    assert.equal(next.versions.length, 3)
    assert.deepEqual(currentVersion(next).changed, ['answerZh', 'answerEn'])
    assert.equal(currentVersion(next).instruction, '短一点')
    // AI 之后再打字：新的人手版本
    const typed = editHistory(next, { questionZh: '退款多久到账？' })
    assert.equal(typed.versions.length, 4)
    assert.deepEqual(
      typed.versions.map((v) => v.n),
      [1, 2, 3, 4],
    )
  })

  test('AI with no change adds nothing', () => {
    assert.equal(aiHistory(startHistory(base()), { answerZh: '3 个工作日。' }, '不用改'), null)
  })

  test('going back and editing an old version appends a new version and keeps every version', () => {
    let history = aiHistory(startHistory(base()), { answerZh: 'AI 版' }, '改') as ReturnType<typeof startHistory>
    history = goTo(history, 0)
    assert.equal(currentVersion(history).draft.answerZh, '3 个工作日。')
    history = editHistory(history, { answerZh: '从第一版改' })
    assert.equal(history.versions.length, 3)
    assert.equal(history.at, 2)
    assert.equal(history.versions[1].draft.answerZh, 'AI 版')
    assert.equal(goTo(history, 99).at, 2)
    assert.equal(goTo(history, -3).at, 0)
  })

  test('rebase swaps the first version only', () => {
    const history = editHistory(startHistory(base()), { answerZh: '新' })
    const rebased = rebase(history, base({ questionZh: '服务器上新的问题' }))
    assert.equal(rebased.versions[0].draft.questionZh, '服务器上新的问题')
    assert.equal(rebased.versions[1].draft.answerZh, '新')
  })

  test('changed fields and selection clean-up', () => {
    assert.deepEqual(changedFields(base(), base({ category: 'other' })), ['category'])
    const draft = base()
    assert.deepEqual(cleanSelection(draft, { field: 'answerZh', start: 5, end: 1 }), { field: 'answerZh', start: 1, end: 5 })
    assert.deepEqual(cleanSelection(draft, { field: 'answerZh', start: 2, end: 999 }), {
      field: 'answerZh',
      start: 2,
      end: draft.answerZh.length,
    })
    assert.equal(cleanSelection(draft, { field: 'answerZh', start: 3, end: 4 }), null)
    assert.equal(cleanSelection(draft, null), null)
  })
})
