import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import type { FaqMapNode, ReviewSimilar } from '../src/backoffice/contracts/helpdesk'
import {
  GROUP_ACTIONS,
  REVIEW_GROUPS,
  buildMapTree,
  choiceProblems,
  defaultChoice,
  groupOf,
  mapPath,
  needsTarget,
  nextInQueue,
  openRoots,
  orderSimilar,
  pathText,
  placeMode,
  scorePercent,
  stateShares,
  switchAction,
  type ReviewChoice,
} from '../src/backoffice/lib/helpdeskReview'

/** FAQ 候选「卡片审核」的纯逻辑（api-spec：candidate-review/api-spec.md）。 */

const choice = (patch: Partial<ReviewChoice> = {}): ReviewChoice => ({
  action: 'new_faq',
  target: null,
  place: null,
  moveTo: null,
  picks: [0],
  ...patch,
})

function node(id: string, kind: FaqMapNode['kind'], parentId: string | null, position?: number): FaqMapNode {
  return { id, key: id, kind, parentId, labelZh: `中${id}`, labelEn: `en${id}`, position, cards: 1 }
}

function similar(faqId: string, score: number, samePlace: boolean): ReviewSimilar {
  return {
    faqId,
    key: faqId,
    questionEn: faqId,
    questionZh: faqId,
    answerExcerptEn: '',
    answerExcerptZh: '',
    entry: true,
    score,
    samePlace,
    placePath: [],
    closeMatch: false,
  }
}

describe('candidate review: the four actions', () => {
  test('every suggestion and no_change belongs to exactly one of add / update / retire / none', () => {
    const all = REVIEW_GROUPS.flatMap((group) => GROUP_ACTIONS[group])
    assert.deepEqual([...all].sort(), ['add_phrasing', 'follow_up', 'new_faq', 'no_change', 'retire_faq', 'update_faq'])
    assert.equal(groupOf('follow_up'), 'add')
    assert.equal(groupOf('add_phrasing'), 'update')
    assert.equal(groupOf('retire_faq'), 'retire')
    assert.equal(groupOf('no_change'), 'none')
  })

  test('defaults follow the AI suggestion; the place is never preselected', () => {
    const candidate = { suggestion: 'add_phrasing' as const, relatedNodeId: 'rel', parentNodeId: 'par' }
    assert.deepEqual(defaultChoice(candidate, null, [0, 2]), {
      action: 'add_phrasing',
      target: 'rel',
      place: null,
      moveTo: null,
      picks: [0, 2],
    })
    const review = { recommendation: { action: 'follow_up' as const, faqId: null, rationale: '', confidence: null } }
    assert.equal(defaultChoice(candidate, review, []).target, 'par')
    const update = { recommendation: { action: 'update_faq' as const, faqId: 'x', rationale: '', confidence: null } }
    assert.deepEqual(defaultChoice(candidate, update, []), { action: 'update_faq', target: 'x', place: null, moveTo: null, picks: [] })
    assert.equal(defaultChoice({ ...candidate, suggestion: 'new_faq' }, null, []).target, null)
  })

  test('switching action keeps a target only where it means something', () => {
    const start = choice({ action: 'update_faq', target: 'x', moveTo: null })
    assert.equal(switchAction(start, 'add_phrasing', null).target, 'x')
    assert.equal(switchAction(start, 'new_faq', null).target, null)
    assert.equal(switchAction(choice({ action: 'new_faq' }), 'retire_faq', 'rec').target, 'rec')
    assert.equal(switchAction(choice({ action: 'retire_faq', target: 'x', moveTo: 'y' }), 'update_faq', null).moveTo, null)
  })

  test('problems: target, place (only when the map has nodes), examples, moving phrasings onto itself', () => {
    assert.deepEqual(choiceProblems(choice(), true), ['needPlace'])
    assert.deepEqual(choiceProblems(choice(), false), [])
    assert.deepEqual(choiceProblems(choice({ action: 'follow_up' }), true), ['needTarget', 'needPlace'])
    assert.deepEqual(choiceProblems(choice({ action: 'update_faq', target: 'x' }), true), [])
    assert.deepEqual(choiceProblems(choice({ action: 'add_phrasing', target: 'x', picks: [] }), true), ['needExamples'])
    assert.deepEqual(choiceProblems(choice({ action: 'retire_faq', target: 'x', moveTo: 'x' }), true), ['moveToSelf'])
    assert.deepEqual(choiceProblems(choice({ action: 'no_change' }), true), [])
    assert.equal(placeMode('update_faq', true), 'optional')
    assert.equal(placeMode('add_phrasing', true), 'hidden')
    assert.equal(needsTarget('new_faq'), false)
  })
})

describe('candidate review: data shaping', () => {
  test('similar cards: same place first, then by score, at most 10', () => {
    const list = [similar('a', 0.99, false), similar('b', 0.5, true), similar('c', 0.9, true)]
    assert.deepEqual(
      orderSimilar(list).map((card) => card.faqId),
      ['c', 'b', 'a'],
    )
    assert.equal(orderSimilar(Array.from({ length: 14 }, (_, i) => similar(`s${i}`, i / 20, false))).length, 10)
  })

  test('map tree: ordered by position, orphans become roots, cycles do not loop', () => {
    const nodes = [
      node('s2', 'stage', null, 2),
      node('s1', 'stage', null, 1),
      node('st', 'step', 's1'),
      node('dv', 'deviation', 'st'),
      node('cell', 'cell', 'missing'),
    ]
    const tree = buildMapTree(nodes)
    assert.deepEqual(
      tree.map((item) => item.node.id),
      ['s1', 's2', 'cell'],
    )
    assert.equal(tree[0].children[0].children[0].node.id, 'dv')
    assert.deepEqual(
      mapPath(nodes, 'dv').map((n) => n.id),
      ['s1', 'st', 'dv'],
    )
    const loop = [node('a', 'step', 'b'), node('b', 'step', 'a')]
    assert.deepEqual(
      mapPath(loop, 'a').map((n) => n.id),
      ['b', 'a'],
    )
    assert.deepEqual([...openRoots(nodes, ['s2'], 'dv')].sort(), ['s1', 's2'])
  })

  test('user state shares in a fixed order, zeros dropped, rounded percent', () => {
    assert.deepEqual(stateShares({ ended: 2, paid_active: 4, cancelling: 3, unknown: 0 }, 9), [
      { bucket: 'paid_active', count: 4, percent: 44 },
      { bucket: 'cancelling', count: 3, percent: 33 },
      { bucket: 'ended', count: 2, percent: 22 },
    ])
    assert.deepEqual(stateShares({ trial_active: 1 }, 0), [{ bucket: 'trial_active', count: 1, percent: 100 }])
  })

  test('queue moves to the next card, or back to the previous at the end', () => {
    assert.equal(nextInQueue(['a', 'b', 'c'], 'b'), 'c')
    assert.equal(nextInQueue(['a', 'b', 'c'], 'c'), 'b')
    assert.equal(nextInQueue(['a'], 'a'), null)
    assert.equal(nextInQueue(['a', 'b'], 'gone'), 'a')
  })

  test('labels', () => {
    const path = [
      { key: 'r', labelZh: '退款', labelEn: 'Refunds' },
      { key: 'r.q', labelZh: '申请退款', labelEn: 'Request' },
    ]
    assert.equal(pathText(path, 'zh-CN'), '退款 › 申请退款')
    assert.equal(pathText(path, 'en-GB'), 'Refunds › Request')
    assert.equal(scorePercent(0.876), '88%')
    assert.equal(scorePercent(1.4), '100%')
  })
})
