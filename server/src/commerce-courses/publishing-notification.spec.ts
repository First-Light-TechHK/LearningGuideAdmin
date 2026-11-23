import { PublishingService } from './publishing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TrialService } from './trial.service';
import type { CommerceCourseConfig } from './commerce.config';

/**
 * Notification P0：COURSE_NEW_LAUNCH 在课程第一次变为 ONLINE 时发出，
 * 且只有最近一次发布勾选了 notifyLearners 才发。
 */
const COURSE_ID = 'course-1';
const LIVE_VERSION_ID = 'version-9';

type Fake = {
  onlineCount: number;
  lastPublishDetail: unknown;
  liveStatus: 'ONLINE' | 'HIDDEN' | 'OFFLINE';
};

function buildService(fake: Fake): PublishingService {
  const prisma = {
    commerceCourse: {
      update: jest.fn(),
      findUnique: jest.fn((args: { select: Record<string, unknown> }) =>
        Promise.resolve(
          'liveVersionId' in args.select
            ? {
                id: COURSE_ID,
                liveVersionId: LIVE_VERSION_ID,
                liveStatus: fake.liveStatus,
              }
            : {
                code: 'C001',
                slug: 'renaissance-in-florence',
                defaultContentLanguage: 'en-GB',
                localizations: [{ language: 'en-GB', title: 'Renaissance' }],
                category: {
                  name: 'Art',
                  localized: { 'en-GB': { name: 'Art History' } },
                },
              },
        ),
      ),
    },
    courseAuthoringActivity: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(fake.onlineCount),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          fake.lastPublishDetail === undefined
            ? null
            : { detail: fake.lastPublishDetail },
        ),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
  return new PublishingService(
    prisma as unknown as PrismaService,
    {} as TrialService,
    {} as CommerceCourseConfig,
  );
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('COURSE_NEW_LAUNCH hook on the first ONLINE', () => {
  const realFetch = globalThis.fetch;
  const saved = {
    base: process.env.PORTAL_NOTIFICATIONS_BASE_URL,
    token: process.env.PORTAL_NOTIFICATIONS_TOKEN,
  };
  let fetchStub: jest.Mock;

  beforeEach(() => {
    process.env.PORTAL_NOTIFICATIONS_BASE_URL = 'http://portal.test';
    process.env.PORTAL_NOTIFICATIONS_TOKEN = 'test-token';
    fetchStub = jest.fn(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    );
    globalThis.fetch = fetchStub as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [name, value] of [
      ['PORTAL_NOTIFICATIONS_BASE_URL', saved.base],
      ['PORTAL_NOTIFICATIONS_TOKEN', saved.token],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const goOnline = (fake: Partial<Fake>) =>
    buildService({
      onlineCount: 1,
      lastPublishDetail: { notifyLearners: true },
      liveStatus: 'OFFLINE',
      ...fake,
    }).changeStatus(COURSE_ID, { status: 'ONLINE', reason: 'Launch' }, null);

  it('sends the event once when notifyLearners was ticked', async () => {
    await goOnline({});
    await flush();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/api/integration/notifications/events')).toBe(true);
    const body = JSON.parse(String(init.body)) as {
      eventType: string;
      eventKey: string;
      params: Record<string, string>;
    };
    expect(body.eventType).toBe('COURSE_NEW_LAUNCH');
    expect(body.eventKey).toBe(`course:${COURSE_ID}:${LIVE_VERSION_ID}`);
    expect(Object.keys(body.params).sort()).toEqual([
      'category_name',
      'course_link',
      'course_title',
    ]);
  });

  it('sends nothing when notifyLearners was not ticked', async () => {
    await goOnline({ lastPublishDetail: { notifyLearners: false } });
    await flush();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('sends nothing the second time the course goes ONLINE', async () => {
    await goOnline({ onlineCount: 2 });
    await flush();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each(['HIDDEN', 'OFFLINE'] as const)(
    'sends nothing when the status changes to %s',
    async (status) => {
      await buildService({
        onlineCount: 1,
        lastPublishDetail: { notifyLearners: true },
        liveStatus: 'ONLINE',
      }).changeStatus(COURSE_ID, { status, reason: 'Pause' }, null);
      await flush();
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it('still returns the status change when the Portal call fails', async () => {
    fetchStub.mockRejectedValue(new Error('portal down'));
    await expect(goOnline({})).resolves.toEqual({
      from: 'OFFLINE',
      to: 'ONLINE',
      reason: 'Launch',
    });
    await flush();
  });
});
