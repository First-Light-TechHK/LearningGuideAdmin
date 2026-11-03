/**
 * 版本发布抽屉的长连接（owner 2026-11-03：「长时间等待不希望要通过刷新来检查，端口应该常连」）。
 * GET /api/helpdesk/faq-releases/stream（SSE）：连上先发一次版本列表，之后列表一变就推（event: releases），
 * 浏览器不再定时重读。
 * - 这个进程里的变化（开始检查、进度、结果、发布）由 FaqReleaseService.onChange 立刻通知；
 * - 后台检查可能跑在别的实例上，「检查中断」也是按心跳时间算出来的，所以服务端自己再对数据库补查：
 *   有版本在检查时每 3 秒一次，没有时每 30 秒一次；只在列表真的变了才推；
 * - 每 20 秒发一行注释，防止负载均衡（ALB 缺省 60 秒）断开空闲连接；断了浏览器的 EventSource
 *   3 秒后自己重连（retry），重连后先拿到最新的列表。
 */
import type { FaqReleaseSummary } from './faqReleaseService';

export const RELEASE_STREAM = {
  activeMs: 3_000,
  idleMs: 30_000,
  pingMs: 20_000,
  /** 一次检查里进度连着来：合并成一次推送。 */
  debounceMs: 200,
  retryMs: 3_000,
} as const;

export type ReleaseStreamTimings = {
  [K in keyof typeof RELEASE_STREAM]: number;
};

export type ReleaseListPayload = {
  releases: FaqReleaseSummary[];
  published: number | null;
};

export type ReleaseStreamDeps = {
  list: () => Promise<ReleaseListPayload>;
  onChange: (listener: () => void) => () => void;
  /** 写一段 SSE 文本；连接已经断了返回 false。 */
  write: (chunk: string) => boolean;
  /** 浏览器断开 = abort。 */
  signal: AbortSignal;
  timings?: Partial<ReleaseStreamTimings>;
};

const running = (payload: ReleaseListPayload) =>
  payload.releases.some(
    (release) =>
      release.status === 'evaluating' &&
      release.evaluation?.state === 'running',
  );

/** 跑到浏览器断开为止（返回的 Promise 在断开后 resolve）。 */
export function streamReleases(deps: ReleaseStreamDeps): Promise<void> {
  const timings: ReleaseStreamTimings = { ...RELEASE_STREAM, ...deps.timings };
  return new Promise<void>((resolve) => {
    let last = '';
    let active = false;
    let closed = false;
    let busy = false;
    let again = false;
    let check: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const close = () => {
      if (closed) return;
      closed = true;
      if (check) clearTimeout(check);
      if (debounce) clearTimeout(debounce);
      clearInterval(ping);
      unsubscribe();
      deps.signal.removeEventListener('abort', close);
      resolve();
    };
    const write = (chunk: string) => {
      if (closed) return;
      if (!deps.write(chunk)) close();
    };
    const schedule = () => {
      if (closed) return;
      if (check) clearTimeout(check);
      check = setTimeout(
        () => void refresh(),
        active ? timings.activeMs : timings.idleMs,
      );
    };
    /** 读一次列表；和上次推的不一样才推。同一时间只读一次（读的时候又有变化 → 读完再读一次）。 */
    const refresh = async () => {
      if (closed) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const payload = await deps.list();
        active = running(payload);
        const body = JSON.stringify(payload);
        if (body !== last) {
          last = body;
          write(`event: releases\ndata: ${body}\n\n`);
        }
      } catch {
        // 数据库一时读不到：下一次再试，连接不断
      } finally {
        busy = false;
      }
      if (again) {
        again = false;
        void refresh();
        return;
      }
      schedule();
    };

    const unsubscribe = deps.onChange(() => {
      if (closed) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), timings.debounceMs);
    });
    const ping = setInterval(() => write(': ping\n\n'), timings.pingMs);
    if (deps.signal.aborted) {
      close();
      return;
    }
    deps.signal.addEventListener('abort', close);
    write(`retry: ${timings.retryMs}\n\n`);
    void refresh();
  });
}
