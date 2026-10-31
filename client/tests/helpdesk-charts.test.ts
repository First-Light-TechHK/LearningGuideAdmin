import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import type { FlywheelJobRun, MetricsRow } from '../src/backoffice/contracts/helpdesk'
import {
  formatChartValue,
  formatTick,
  jobPoints,
  latestValue,
  linePath,
  metricPoints,
  nearestIndex,
  niceMax,
  runMarks,
  xLabelIndexes,
  yDomain,
  type Frame,
} from '../src/backoffice/lib/helpdeskCharts'

/** 「HelpDesk 数据」折线图的纯逻辑。 */

function row(bucket: string | null, patch: Partial<MetricsRow> = {}): MetricsRow {
  return {
    bucket,
    segment: 'all',
    turns: 10,
    answers: 8,
    answersSettled: 8,
    aiSolved: 4,
    noMatch: 2,
    votes: 0,
    helpful: 0,
    ratings: 0,
    ratingSum: 0,
    handovers: 1,
    clarify: 0,
    clarifyCovered: 0,
    guarded: 0,
    guardFallback: 0,
    unsolved: 0,
    aiSolvedRate: 0.5,
    noMatchRate: 0.2,
    helpfulRate: null,
    avgRating: null,
    handoverRate: 0.1,
    clarifyCoveredRate: null,
    guardFallbackRate: null,
    ...patch,
  }
}

function run(day: string, status: FlywheelJobRun['status'], startedAt: string, received = 0, created = 0): FlywheelJobRun {
  return {
    id: `${day}-${startedAt}`,
    job: 'gap_mining',
    day,
    trigger: 'schedule',
    status,
    attempts: 1,
    instance: 'i1',
    startedAt,
    heartbeatAt: startedAt,
    finishedAt: startedAt,
    durationMs: 1000,
    stats: { pull: { status: 'pulled', received }, mine: { created } },
    moreDue: false,
    errorCode: status === 'failed' ? 'PORTAL_UNAVAILABLE' : null,
    requestedBy: null,
  }
}

const frame: Frame = { width: 140, height: 120, left: 20, right: 20, top: 10, bottom: 10 }

describe('helpdesk charts: data', () => {
  test('metric points are sorted by bucket, keep null as a gap, and carry the partial flag and detail', () => {
    const rows = [
      row('2026-10-30', { helpfulRate: 0.75 }),
      row('2026-10-28'),
      row(null),
      row('2026-10-29', { partial: true, helpfulRate: 0.5 }),
      row('2026-10-29'),
    ]
    const points = metricPoints(rows, 'helpfulRate', (r, key) => `${key}:${r.bucket}`)
    assert.deepEqual(
      points.map((p) => [p.bucket, p.value, p.partial ?? false]),
      [
        ['2026-10-28', null, false],
        ['2026-10-29', 0.5, true],
        ['2026-10-30', 0.75, false],
      ],
    )
    assert.equal(points[2].detail, 'helpfulRate:2026-10-30')
    assert.deepEqual(
      metricPoints(rows, 'turns').map((p) => [p.value, p.detail]),
      [
        [10, undefined],
        [10, undefined],
        [10, undefined],
      ],
    )
  })

  test('job runs: the last run of each day wins; a failed day is a gap in the line and a ✕ in the strip', () => {
    const runs = [
      run('2026-10-30', 'failed', '2026-10-30T02:00:00Z'),
      run('2026-10-30', 'succeeded', '2026-10-30T03:00:00Z', 120, 4),
      run('2026-10-29', 'failed', '2026-10-29T02:00:00Z'),
      run('2026-10-31', 'succeeded', '2026-10-31T02:00:00Z', 80, 1),
    ]
    assert.deepEqual(
      jobPoints(runs).map((p) => [p.bucket, p.value]),
      [
        ['2026-10-29', null],
        ['2026-10-30', 120],
        ['2026-10-31', 80],
      ],
    )
    assert.deepEqual(
      runMarks(runs).map((m) => [m.day, m.status, m.created]),
      [
        ['2026-10-29', 'failed', 0],
        ['2026-10-30', 'succeeded', 4],
        ['2026-10-31', 'succeeded', 1],
      ],
    )
  })

  test('latest value skips trailing gaps', () => {
    assert.equal(
      latestValue([
        { bucket: 'a', value: 1 },
        { bucket: 'b', value: null },
      ])?.bucket,
      'a',
    )
    assert.equal(latestValue([{ bucket: 'a', value: null }]), null)
  })
})

describe('helpdesk charts: scales and drawing', () => {
  test('nice maxima and domains: rates from 0 and at most 100%, ratings 1 to 5, counts from 0', () => {
    assert.deepEqual([niceMax(0), niceMax(7), niceMax(13), niceMax(0.42), niceMax(240)], [1, 10, 20, 0.5, 250])
    const pts = (...values: (number | null)[]) => values.map((value, i) => ({ bucket: String(i), value }))
    assert.deepEqual(yDomain('rate', pts(0.31, 0.62, null)), [0, 1])
    assert.deepEqual(yDomain('rate', pts(0.12, 0.18)), [0, 0.2])
    assert.deepEqual(yDomain('rate', pts(null)), [0, 0.1])
    assert.deepEqual(yDomain('rating', pts(4.2)), [1, 5])
    assert.deepEqual(yDomain('count', pts(3, 17)), [0, 20])
  })

  test('line path breaks at null and starts a new segment', () => {
    const points = [
      { bucket: 'a', value: 0 },
      { bucket: 'b', value: 1 },
      { bucket: 'c', value: null },
      { bucket: 'd', value: 0.5 },
      { bucket: 'e', value: 0.5 },
    ]
    assert.equal(linePath(points, [0, 1], frame), 'M20.0 110.0 L45.0 10.0 M95.0 60.0 L120.0 60.0')
    assert.equal(linePath([{ bucket: 'a', value: null }], [0, 1], frame), '')
  })

  test('pointer picks the nearest bucket and stays in range; axis labels at start, middle, end', () => {
    assert.equal(nearestIndex(20, 5, frame), 0)
    assert.equal(nearestIndex(60, 5, frame), 2)
    assert.equal(nearestIndex(500, 5, frame), 4)
    assert.equal(nearestIndex(-40, 5, frame), 0)
    assert.equal(nearestIndex(70, 1, frame), 0)
    assert.deepEqual(xLabelIndexes(7), [0, 3, 6])
    assert.deepEqual(xLabelIndexes(2), [0, 1])
    assert.deepEqual(xLabelIndexes(1), [0])
    assert.deepEqual(xLabelIndexes(0), [])
  })

  test('value and tick formats', () => {
    assert.equal(formatChartValue('rate', 0.625), '63%')
    assert.equal(formatChartValue('rate', 0.034), '3.4%')
    assert.equal(formatChartValue('rate', 0), '0%')
    assert.equal(formatChartValue('rating', 4.256), '4.26')
    assert.equal(formatChartValue('count', 12), '12')
    assert.equal(formatChartValue('count', null), '—')
    assert.equal(formatTick('rate', 0.5), '50%')
    assert.equal(formatTick('count', 2500), '2.5k')
    assert.equal(formatTick('rating', 3), '3')
  })
})
