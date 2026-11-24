import { useEffect, useRef } from 'react';

import { readDraft, removeDraft, writeDraft, type DraftIdentity } from '../../lib/editorDraftStore';
import { sameValue } from './drafts/merge';

/**
 * 挂载 / 身份变化时的三路合并（P96）：
 *   stored.draft 与 stored.base 不同 = 用户改过 → 保留用户值；
 *   相同 = 没改过 → 跟随最新服务器快照。
 * 只有合并后仍有脏字段才算「恢复」，才提示；返回的 value 用最新服务器快照做后续基线。
 */
export function restoreDraft<T>(
  identity: DraftIdentity | null,
  server: T,
  adapters: {
    parse: (raw: unknown) => T | null;
    merge: (draft: T, base: T, server: T) => T;
    dirty: (draft: T, base: T) => boolean;
  },
): { value: T; restored: boolean; serverChanged: boolean } {
  if (!identity) return { value: server, restored: false, serverChanged: false };
  const stored = readDraft(identity, adapters.parse);
  if (!stored) return { value: server, restored: false, serverChanged: false };
  const merged = adapters.merge(stored.draft, stored.base, server);
  return {
    value: merged,
    restored: adapters.dirty(merged, server),
    serverChanged: !sameValue(stored.base, server),
  };
}

function identitySignature(identity: DraftIdentity | null): string {
  return identity ? `${identity.courseId}|${identity.step}|${identity.lessonId ?? ''}|${identity.language ?? ''}` : '';
}

type AutosaveState<T> = {
  identity: DraftIdentity | null;
  draft: T;
  base: T;
  dirty: (draft: T, base: T) => boolean;
};

/**
 * 把 section 的草稿写进 sessionStorage：
 * - 字段变化后防抖写入（无关重渲染不会推迟写盘）；
 * - 身份变化 / 组件卸载 / pagehide / 页面隐藏时同步 flush；
 * - 只在脏时写；草稿与基线一致时删除记录（保存后重载合并为 clean 也就自动清除）。
 */
export function useDraftAutosave<T>(
  identity: DraftIdentity | null,
  draft: T,
  base: T,
  dirty: (draft: T, base: T) => boolean,
  debounceMs = 500,
): void {
  const latest = useRef<AutosaveState<T> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = (state: AutosaveState<T> | null) => {
    if (!state || !state.identity) return;
    if (state.dirty(state.draft, state.base)) writeDraft(state.identity, { base: state.base, draft: state.draft });
    else removeDraft(state.identity);
  };

  // 每次提交后比较一次：数据真变了才重置防抖计时器。
  useEffect(() => {
    const previous = latest.current;
    const sameIdentity = identitySignature(previous?.identity ?? null) === identitySignature(identity);
    if (previous && !sameIdentity) {
      // 切身份前先把旧身份的草稿同步落盘（不能依赖卸载清理的顺序）。
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      persist(previous);
    }
    latest.current = { identity, draft, base, dirty };
    if (!identity) return;
    if (previous && sameIdentity && sameValue(previous.draft, draft) && sameValue(previous.base, base)) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      persist(latest.current);
    }, debounceMs);
  });

  // 卸载 / 页面离开的同步兜底（sessionStorage 写入是同步的）。
  useEffect(() => {
    const flush = () => persist(latest.current);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      flush();
    };
  }, []);
}
