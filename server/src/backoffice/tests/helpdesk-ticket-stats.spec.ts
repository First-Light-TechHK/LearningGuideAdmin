import type { TicketStats } from '../modules/helpdesk/contracts';
import { createFlywheelMetrics } from '../modules/helpdesk/flywheel/flywheelMetrics';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * 工单每日数字（数据页）：Admin 只校验日期范围、转给 Portal 的 /ticket-stats；
 * 默认最近 28 天（UTC），至多 92 天；没接 Portal = 503 HELPDESK_NOT_CONNECTED。
 */
const STATS: TicketStats = {
  from: '2026-10-30',
  to: '2026-10-31',
  timeZone: 'UTC',
  days: [],
  totals: {
    created: 0,
    resolved: 0,
    cancelled: 0,
    firstReplies: 0,
    firstReplyMedianMinutes: null,
    firstReplyP90Minutes: null,
  },
};

function setup(withPortal = true) {
  const ticketStats = jest.fn(() => Promise.resolve(STATS));
  const metrics = createFlywheelMetrics({
    insights: {
      metrics: jest.fn(),
      topGapGroups: jest.fn(),
      ticketFaqs: jest.fn(),
      lastIngestedAt: jest.fn(),
    },
    graph: { summaries: jest.fn() },
    portal: withPortal ? { ticketStats } : undefined,
    now: () => new Date('2026-10-31T20:00:00Z'),
  });
  return { metrics, ticketStats };
}

async function rejects(
  work: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HelpdeskError);
  expect(error).toMatchObject({ status, code });
}

describe('ticket daily numbers in the data tab', () => {
  it('asks Portal for the last 28 UTC days by default', async () => {
    const { metrics, ticketStats } = setup();
    await expect(metrics.ticketStats({})).resolves.toEqual(STATS);
    expect(ticketStats).toHaveBeenCalledWith({
      from: '2026-10-04',
      to: '2026-10-31',
    });
  });

  it('passes the chosen range through and accepts up to 92 days', async () => {
    const { metrics, ticketStats } = setup();
    await metrics.ticketStats({ from: '2026-08-01', to: '2026-10-31' });
    expect(ticketStats).toHaveBeenLastCalledWith({
      from: '2026-08-01',
      to: '2026-10-31',
    });
  });

  it('refuses a bad, reversed or too long range without calling Portal', async () => {
    const { metrics, ticketStats } = setup();
    for (const raw of [
      { from: '2026-10-31', to: '2026-10-30' },
      { from: '2026-07-31', to: '2026-10-31' },
      { from: '2026-02-30' },
      { to: '31/10/2026' },
      { from: ['2026-10-01'] },
    ])
      await rejects(metrics.ticketStats(raw), 400, 'INVALID_INPUT');
    expect(ticketStats).not.toHaveBeenCalled();
  });

  it('answers 503 when Portal is not connected', async () => {
    const { metrics } = setup(false);
    await rejects(metrics.ticketStats({}), 503, 'HELPDESK_NOT_CONNECTED');
  });
});
