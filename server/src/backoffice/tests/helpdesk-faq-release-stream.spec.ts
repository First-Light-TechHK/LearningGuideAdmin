import {
  type ReleaseListPayload,
  streamReleases,
} from '../modules/helpdesk/faqs/faqReleaseStream';
import type { FaqReleaseSummary } from '../modules/helpdesk/faqs/faqReleaseService';

/**
 * 版本发布抽屉的长连接（owner 2026-11-03「端口应该常连」）：连上先推一次，列表变了才推，
 * 有版本在检查时服务端自己对数据库补查（别的实例上的进度、心跳停了变「检查中断」），
 * 断开后不再读、不再写，订阅也撤掉。
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timings = {
  activeMs: 30,
  idleMs: 5_000,
  pingMs: 5_000,
  debounceMs: 5,
  retryMs: 3_000,
};

function release(
  version: number,
  patch: Partial<FaqReleaseSummary> = {},
): FaqReleaseSummary {
  return {
    id: `r${version}`,
    version,
    status: 'draft',
    publishable: true,
    evaluation: null,
    ...patch,
  } as FaqReleaseSummary;
}

const runningAt = (done: number) =>
  release(3, {
    status: 'evaluating',
    publishable: false,
    evaluation: {
      state: 'running',
      startedAt: '2026-11-03T10:00:00.000Z',
      progress: { stage: 'model', done, total: 300 },
    },
  });

function harness(initial: ReleaseListPayload) {
  let payload = initial;
  let reads = 0;
  let fail = false;
  const listeners = new Set<() => void>();
  const chunks: string[] = [];
  let open = true;
  const controller = new AbortController();
  const done = streamReleases({
    list: () => {
      reads += 1;
      return fail
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(payload);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (chunk) => {
      if (!open) return false;
      chunks.push(chunk);
      return true;
    },
    signal: controller.signal,
    timings,
  });
  const pushed = () =>
    chunks
      .filter((c) => c.startsWith('event: releases'))
      .map(
        (c) =>
          JSON.parse(c.slice(c.indexOf('data: ') + 6)) as ReleaseListPayload,
      );
  return {
    set: (next: ReleaseListPayload) => {
      payload = next;
    },
    notify: () => listeners.forEach((l) => l()),
    failReads: (value: boolean) => {
      fail = value;
    },
    disconnect: () => {
      open = false;
    },
    abort: () => controller.abort(),
    chunks,
    pushed,
    reads: () => reads,
    listeners,
    done,
  };
}

describe('FAQ release stream (SSE)', () => {
  it('sends retry and the list at once; a change in this process is pushed; an unchanged list is not', async () => {
    const h = harness({ releases: [release(2)], published: 1 });
    await wait(10);
    expect(h.chunks[0]).toBe('retry: 3000\n\n');
    expect(h.pushed()).toHaveLength(1);
    expect(h.pushed()[0].releases[0].version).toBe(2);

    h.notify(); // 什么都没变
    await wait(20);
    expect(h.pushed()).toHaveLength(1);

    h.set({ releases: [runningAt(0), release(2)], published: 1 });
    h.notify();
    h.notify();
    h.notify(); // 连着的变化合并成一次读
    await wait(20);
    expect(h.pushed()).toHaveLength(2);
    expect(h.pushed()[1].releases[0].evaluation?.progress?.done).toBe(0);

    h.abort();
    await h.done;
    expect(h.listeners.size).toBe(0);
  });

  it('while a check runs it re-reads the database by itself (progress from another instance), then slows down when done', async () => {
    const h = harness({ releases: [runningAt(120)], published: null });
    await wait(10);
    h.set({ releases: [runningAt(210)], published: null }); // 别的实例写的，这个进程没收到通知
    await wait(60);
    expect(
      h.pushed().map((p) => p.releases[0].evaluation?.progress?.done),
    ).toEqual([120, 210]);
    h.set({ releases: [release(3)], published: null });
    await wait(60);
    expect(h.pushed().at(-1)?.releases[0].status).toBe('draft');
    // 没有在检查的了：不再每 30 ms 读（idle 5 秒）
    const reads = h.reads();
    await wait(100);
    expect(h.reads()).toBe(reads);
    h.abort();
    await h.done;
  });

  it('a failed read keeps the connection; a closed connection stops reading and unsubscribes', async () => {
    const h = harness({ releases: [runningAt(10)], published: null });
    await wait(10);
    h.failReads(true);
    await wait(70);
    expect(h.pushed()).toHaveLength(1);
    h.failReads(false);
    h.set({ releases: [runningAt(20)], published: null });
    await wait(60);
    expect(h.pushed()).toHaveLength(2);

    h.disconnect();
    h.set({ releases: [runningAt(30)], published: null });
    await h.done; // 下一次写失败 → 结束
    expect(h.listeners.size).toBe(0);
    const reads = h.reads();
    await wait(80);
    expect(h.reads()).toBe(reads);
  });

  it('an already aborted request ends at once without reading', async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    await streamReleases({
      list: () => {
        reads += 1;
        return Promise.resolve({ releases: [], published: null });
      },
      onChange: () => () => undefined,
      write: () => true,
      signal: controller.signal,
      timings,
    });
    expect(reads).toBe(0);
  });

  it('pings so a load balancer does not drop the idle connection', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const done = streamReleases({
      list: () => Promise.resolve({ releases: [], published: null }),
      onChange: () => () => undefined,
      write: (chunk) => {
        chunks.push(chunk);
        return true;
      },
      signal: controller.signal,
      timings: { ...timings, pingMs: 15 },
    });
    await wait(50);
    controller.abort();
    await done;
    expect(
      chunks.filter((c) => c === ': ping\n\n').length,
    ).toBeGreaterThanOrEqual(2);
  });
});
