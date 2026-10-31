/**
 * 发布后自动换新（2026-10-31）。
 *
 * 背景：入口 index.html 曾被 `immutable` 缓存一年（a908079 之前），普通 F5 不校验
 * 文档，必须 Ctrl+F5 或开无痕。服务端头已修好，但已落进浏览器的那份缓存无法覆盖，
 * 只能一次性强刷清掉。此模块让后续发布不再需要任何手动刷新：
 *
 * 服务端 `GET /version.json` 返回前端构建哈希（见 server/src/common/build-version.ts）；
 * 这里定期以及页面重新可见时回取自述版本，与本次页面加载的版本不一致时自动 reload。
 *
 * 三条保护：
 * ① 只在页面隐藏或用户没在编辑表单时 reload，避免吞掉员工正在填的内容；
 * ② 新版本要连续两次观测一致才动作，避开滚动发布期间多实例交替应答；
 * ③ reloaded 记在 sessionStorage 里，同一版本只会触发一次，不会造成刷新循环。
 */
export const VERSION_ENDPOINT = '/version.json';

/** 轮询间隔：5 分钟。发布不频繁，再密只是浪费请求。 */
export const VERSION_POLL_MS = 5 * 60 * 1000;
/** 同一新版本需要连续观测到的次数，抵消滚动发布期间的实例抖动。 */
export const VERSION_STABLE_POLLS = 2;

export interface VersionWatchState {
  /** 本次页面加载时的构建哈希；null 表示服务端没有前端产物。 */
  current: string | null;
  /** 正在等待稳定确认的新版本。 */
  pending: string | null;
  /** pending 连续出现的次数。 */
  pendingCount: number;
  /** 本标签页已经为哪个版本刷新过。 */
  reloaded: string | null;
}

export type VersionDecision = 'ignore' | 'wait' | 'reload';

export function initialVersionState(current: string | null, reloaded: string | null = null): VersionWatchState {
  return { current, pending: null, pendingCount: 0, reloaded };
}

/**
 * 纯逻辑：给一次观测结果，决定是否需要刷新。
 * 不读时钟、不碰 DOM，便于单测。
 */
export function decideVersionPoll(state: VersionWatchState, observed: string | null): VersionDecision {
  // 服务端没有构建标识，或与当前一致：无事可做。
  if (!observed || observed === state.current) {
    state.pending = null;
    state.pendingCount = 0;
    return 'ignore';
  }
  // 该版本已经刷新过：服务端可能还没轮到新实例，静默等待，避免循环刷新。
  if (observed === state.reloaded) {
    state.pending = null;
    state.pendingCount = 0;
    return 'ignore';
  }
  if (observed === state.pending) state.pendingCount += 1;
  else {
    state.pending = observed;
    state.pendingCount = 1;
  }
  return state.pendingCount >= VERSION_STABLE_POLLS ? 'reload' : 'wait';
}

/** 员工正在输入时不要 reload，否则会丢掉未提交的内容。 */
export function isEditing(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  const tag = active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return active.isContentEditable === true;
}

export interface VersionWatchOptions {
  /** 本次页面加载的构建标识；默认取服务端注入的 meta。null 表示不看守。 */
  currentVersion?: string | null;
  fetchVersion?: () => Promise<string | null>;
  reload?: () => void;
  isHidden?: () => boolean;
  isEditing?: () => boolean;
  pollMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** 每次决策后的回调，便于诊断；默认不打日志。 */
  onDecision?: (decision: VersionDecision, state: VersionWatchState) => void;
}

const RELOADED_KEY = 'lg.backoffice.reloaded-version';
const BUILD_META_NAME = 'lg-build';

/** 读取服务端注入的构建标识；本地 vite dev 没有这个 meta，返回 null。 */
export function readBuildMeta(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): string | null {
  const meta = doc?.querySelector(`meta[name="${BUILD_META_NAME}"]`);
  const value = meta?.getAttribute('content')?.trim();
  return value ? value : null;
}

async function defaultFetchVersion(): Promise<string | null> {
  const response = await fetch(VERSION_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) return null;
  const body = (await response.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : null;
}

/**
 * 启动版本守护，返回停止函数。
 * 任何异常都吞掉：版本检查出错绝不能影响 BackOffice 本身。
 */
export function startVersionWatch(options: VersionWatchOptions = {}): () => void {
  const current = options.currentVersion ?? readBuildMeta();
  // 没有构建标识（本地 dev、纯 API 角色）就不看守：否则会把"未知"当成版本变化。
  if (!current) return () => undefined;

  const fetchVersion = options.fetchVersion ?? defaultFetchVersion;
  const reload = options.reload ?? (() => window.location.reload());
  const isHidden = options.isHidden ?? (() => document.visibilityState === 'hidden');
  const editing = options.isEditing ?? isEditing;
  const pollMs = options.pollMs ?? VERSION_POLL_MS;
  const storage = options.storage ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage);

  const saved = storage?.getItem(RELOADED_KEY) ?? null;
  const state = initialVersionState(current, saved === '' ? null : saved);
  let stopped = false;

  async function observe(): Promise<void> {
    if (stopped) return;
    let observed: string | null = null;
    try {
      observed = await fetchVersion();
    } catch {
      return;
    }
    if (stopped || !observed) return;
    const decision = decideVersionPoll(state, observed);
    options.onDecision?.(decision, state);
    if (decision !== 'reload') return;
    // 页面可见且用户正在编辑：先记下，等失焦或隐藏后的下一次观测再刷新。
    if (!isHidden() && editing()) return;
    state.reloaded = observed;
    try {
      storage?.setItem(RELOADED_KEY, observed);
    } catch {
      /* 隐私模式下写不进去也要能刷新 */
    }
    reload();
  }

  void observe();
  const timer = setInterval(() => void observe(), pollMs);
  // 标签页重新可见或窗口获焦时立刻查一次：切回来就换新，不用等 5 分钟。
  const onActivity = () => void observe();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onActivity);
    window.addEventListener('focus', onActivity);
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onActivity);
      window.removeEventListener('focus', onActivity);
    }
  };
}
