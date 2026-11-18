import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  createCourseBody,
  exhibitOrderBody,
  informationBody,
  understandingImportForm,
  lessonInfoBody,
  lessonOrderBody,
  lessonTextBody,
  movedIds,
  readingsBody,
  timeToSend,
  triggersBody,
  videoPointsBody,
} from '../src/backoffice/lib/courseRequests'

describe('informationBody', () => {
  const draft = {
    categoryId: 'cat-1',
    titleEn: ' Title ',
    titleZh: '标题',
    descEn: 'Short',
    descZh: '简介',
    overviewEn: 'Overview',
    overviewZh: '概述',
    learnRows: [
      { en: 'Learn A', zh: '学 A' },
      { en: '', zh: '学 B' },
      { en: 'Learn C', zh: '' },
    ],
    providesRows: [
      { en: 'Provide A', zh: '提供 A' },
      { en: 'Provide B', zh: ' ' },
    ],
  }

  test('sends both languages with provides and whatYouLearn as plain string arrays', () => {
    const body = informationBody(draft)
    assert.equal(body.categoryId, 'cat-1')
    assert.deepEqual(Object.keys(body.localizations).sort(), ['en-GB', 'zh-CN'])
    assert.equal(body.localizations['en-GB'].title, 'Title')
    assert.deepEqual(body.localizations['en-GB'].provides, ['Provide A', 'Provide B'])
    assert.deepEqual(body.localizations['zh-CN'].provides, ['提供 A', ''])
    for (const side of Object.values(body.localizations)) {
      assert.ok(side.provides.every((item) => typeof item === 'string'))
      assert.ok(side.whatYouLearn.every((item) => typeof item === 'string'))
    }
  })

  test('keeps an empty half at its position so the two lists stay aligned', () => {
    const body = informationBody(draft)
    assert.deepEqual(body.localizations['en-GB'].whatYouLearn, ['Learn A', '', 'Learn C'])
    assert.deepEqual(body.localizations['zh-CN'].whatYouLearn, ['学 A', '学 B', ''])
  })

  test('an empty category is sent as null, and added languages only when there are some', () => {
    assert.equal(informationBody({ ...draft, categoryId: '' }).categoryId, null)
    assert.equal('addLearningLanguages' in informationBody(draft), false)
    assert.deepEqual(informationBody(draft, ['zh-CN']).addLearningLanguages, ['zh-CN'])
  })
})

describe('createCourseBody', () => {
  const input = { titleEn: ' English ', titleZh: ' 中文 ', languages: ['zh-CN', 'en-GB'], mode: 'VIDEO', categoryId: '' }

  test('sends the title of both languages and leaves the Course ID and slug to the server', () => {
    const body = createCourseBody(input)
    assert.deepEqual(body.titles, { 'en-GB': 'English', 'zh-CN': '中文' })
    assert.equal('code' in body, false)
    assert.equal('slug' in body, false)
    assert.equal(body.categoryId, null)
    assert.equal(body.learningMode, 'VIDEO')
    assert.deepEqual(body.learningLanguages, ['zh-CN', 'en-GB'])
  })

  test('the default content language is English when it is learned, else the first language', () => {
    assert.equal(createCourseBody(input).defaultContentLanguage, 'en-GB')
    assert.equal(createCourseBody({ ...input, languages: ['zh-CN'] }).defaultContentLanguage, 'zh-CN')
  })
})

describe('understandingImportForm', () => {
  test('puts language and lessonId in the form body, never in a URL', () => {
    const form = understandingImportForm(new Blob(['x']), 'en-GB', 'lesson-uuid')
    assert.equal(form.get('language'), 'en-GB')
    assert.equal(form.get('lessonId'), 'lesson-uuid')
    assert.ok(form.get('file') instanceof Blob)
  })

  test('without a lesson the form carries no lessonId (all lessons)', () => {
    const form = understandingImportForm(new Blob(['x']), 'zh-CN')
    assert.equal(form.get('lessonId'), null)
    assert.equal(form.get('language'), 'zh-CN')
  })
})

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
