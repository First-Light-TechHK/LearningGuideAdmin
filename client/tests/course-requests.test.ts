import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  exhibitOrderBody,
  lessonInfoBody,
  lessonOrderBody,
  lessonTextBody,
  movedIds,
  readingsBody,
  timeToSend,
  triggersBody,
  videoPointsBody,
} from '../src/backoffice/lib/courseRequests'

describe('timeToSend', () => {
  test('mm:ss, h:mm:ss and bare seconds become integer seconds', () => {
    assert.equal(timeToSend('3:15'), 195)
    assert.equal(timeToSend(' 3 : 15 '), 195)
    assert.equal(timeToSend('3：15'), 195)
    assert.equal(timeToSend('1:02:03'), 3723)
    assert.equal(timeToSend('180'), 180)
    assert.equal(timeToSend('0:00'), 0)
  })

  test('empty is null; anything unreadable is sent as typed so the server answers INVALID_TIME', () => {
    assert.equal(timeToSend(''), null)
    assert.equal(timeToSend('   '), null)
    assert.equal(timeToSend('abc'), 'abc')
    assert.equal(timeToSend('1:75'), '1:75')
    assert.equal(timeToSend('-5'), '-5')
    assert.equal(timeToSend('1.5'), '1.5')
  })
})

describe('request bodies', () => {
  test('video points keep id and code for existing rows and send times as seconds, bad times raw', () => {
    const body = videoPointsBody('en-GB', [
      { id: 'p1', code: 'V1', title: 'One', timeText: '0:30' },
      { title: 'New', timeText: 'soon' },
    ])
    assert.deepEqual(body, {
      language: 'en-GB',
      points: [
        { id: 'p1', code: 'V1', title: 'One', timeSeconds: 30 },
        { title: 'New', timeSeconds: 'soon' },
      ],
    })
  })

  test('triggers send a blank exhibit as null and a blank time as null', () => {
    assert.deepEqual(triggersBody('zh-CN', [{ exhibitId: '', timeText: '' }, { exhibitId: 'e1', timeText: '1:00' }]), {
      language: 'zh-CN',
      triggers: [{ exhibitId: null, timeSeconds: null }, { exhibitId: 'e1', timeSeconds: 60 }],
    })
  })

  test('readings are one list with no language, ids only on existing rows, blank rows kept', () => {
    const body = readingsBody([
      { id: 'r1', type: 'BOOK', title: 'A', author: 'B', whyRecommended: 'C' },
      { type: 'ARTICLE', title: '', author: '', whyRecommended: '' },
    ])
    assert.deepEqual(body, {
      readings: [
        { id: 'r1', type: 'BOOK', title: 'A', author: 'B', whyRecommended: 'C' },
        { type: 'ARTICLE', title: '', author: '', whyRecommended: '' },
      ],
    })
    assert.ok(!('language' in body))
  })

  test('lesson info never carries a lesson code or id; text sends the html as is', () => {
    const info = lessonInfoBody('en-GB', 'T', 'D')
    assert.deepEqual(info, { language: 'en-GB', title: 'T', description: 'D' })
    assert.deepEqual(lessonTextBody('zh-CN', '<h1 data-lp="T1">x</h1>'), { language: 'zh-CN', textHtml: '<h1 data-lp="T1">x</h1>' })
  })

  test('order bodies list every id', () => {
    assert.deepEqual(lessonOrderBody(['a', 'b', 'c']), { lessonIds: ['a', 'b', 'c'] })
    assert.deepEqual(exhibitOrderBody(['x', 'y']), { exhibitIds: ['x', 'y'] })
  })

  test('movedIds swaps with the neighbour and refuses to go past either end', () => {
    assert.deepEqual(movedIds(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
    assert.deepEqual(movedIds(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])
    assert.equal(movedIds(['a', 'b'], 'a', -1), null)
    assert.equal(movedIds(['a', 'b'], 'b', 1), null)
    assert.equal(movedIds(['a'], 'z', 1), null)
  })
})
