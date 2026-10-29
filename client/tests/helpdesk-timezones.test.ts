import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { cardTime, dayLabel, groupByDay, listTime, longDate } from '../src/backoffice/lib/helpdeskView'

/**
 * 日期与时间按员工所在时区显示（register.mjs 把其它测试固定在 UTC）。这里在运行中切换 TZ，
 * 锁住东八区（Asia/Shanghai）与美西（America/Los_Angeles，2026-10-28 仍是夏令时 UTC−7）的
 * 日期、分隔条分组、今天 / 昨天与列表时间，包括跨本地午夜的情况。
 */

function inZone(zone: string) {
  process.env.TZ = zone
}

afterEach(() => {
  process.env.TZ = 'UTC'
})

describe('HelpDesk dates follow the agent’s time zone', () => {
  test('Asia/Shanghai: an evening UTC enquiry is the next morning; cards on either side of UTC midnight share one separator', () => {
    inZone('Asia/Shanghai')
    assert.equal(longDate('2026-10-28T20:30:00Z', 'en-GB'), '29 Oct 2026')
    assert.equal(longDate('2026-10-28T20:30:00Z', 'zh-CN'), '2026年10月29日')
    assert.equal(cardTime('2026-10-28T20:30:00Z', 'en-GB'), '04:30')
    const card = (id: string, createdAt: string) => ({ id, createdAt })
    const groups = groupByDay([card('a', '2026-10-29T01:00:00Z'), card('b', '2026-10-28T20:30:00Z'), card('c', '2026-10-28T15:00:00Z')], 'en-GB')
    assert.deepEqual(
      groups.map((group) => [group.label, group.cards.map((item) => item.id)]),
      [
        ['29 Oct 2026', ['a', 'b']],
        ['28 Oct 2026', ['c']],
      ],
    )
  })

  test('Asia/Shanghai: today / yesterday and the list time switch at local midnight, not UTC midnight', () => {
    inZone('Asia/Shanghai')
    const now = new Date('2026-10-28T16:30:00Z') // 29 Oct 00:30 in Shanghai
    assert.deepEqual(dayLabel('2026-10-28T16:10:00Z', 'en-GB', now), { kind: 'today' })
    assert.deepEqual(dayLabel('2026-10-28T15:30:00Z', 'en-GB', now), { kind: 'yesterday' }, '23:30 local is yesterday')
    assert.equal(listTime('2026-10-28T16:10:00Z', 'en-GB', now), '00:10')
    assert.equal(listTime('2026-10-28T15:30:00Z', 'en-GB', now), '28 Oct')
  })

  test('America/Los_Angeles: an early UTC enquiry is the previous evening', () => {
    inZone('America/Los_Angeles')
    assert.equal(longDate('2026-10-29T03:00:00Z', 'en-GB'), '28 Oct 2026')
    assert.equal(cardTime('2026-10-29T03:00:00Z', 'en-GB'), '20:00')
    const now = new Date('2026-10-29T08:30:00Z') // 29 Oct 01:30 in Los Angeles
    assert.deepEqual(dayLabel('2026-10-29T06:00:00Z', 'en-GB', now), { kind: 'yesterday' }, '23:00 local on the 28th')
    assert.deepEqual(dayLabel('2026-10-29T07:30:00Z', 'en-GB', now), { kind: 'today' })
    assert.equal(listTime('2026-10-29T07:30:00Z', 'zh-CN', now), '00:30')
  })
})
