/**
 * 课程编辑器的本地草稿暂存（sessionStorage）。
 *
 * 目的：切页签（组件卸载）、整页刷新（F5）后，未保存的编辑内容仍能恢复；
 * 只在本地暂存，不自动保存到服务器。key 里带 schema 版本与身份
 * （课程 / 步骤 / 课时 / 内容语言），不同身份的草稿互不影响。
 *
 * 所有读写都包 try/catch：隐私模式 / 配额满 / 存储被禁用时静默降级为 no-op，
 * 编辑器保持今天的可用行为，不崩、不提示。
 */
export type DraftStep = 'info' | 'study' | 'understanding';

export type DraftIdentity = {
  courseId: string;
  step: DraftStep;
  /** info 步按课程整体编辑，不带课时与语言。 */
  lessonId?: string;
  language?: string;
};

export type StoredDraft<T> = {
  v: 1;
  identity: DraftIdentity;
  updatedAt: number;
  /** 这段草稿编辑时所依据的服务器快照（三路合并的基线）。 */
  base: T;
  /** 用户当前草稿（只含可序列化的白名单字段）。 */
  draft: T;
};

/** 所有草稿 key 的公共前缀（版本无关，退出登录 / 清理时按它扫）。 */
export const DRAFT_KEY_PREFIX = 'lg.bo.course-editor.draft.';

const KEY_VERSION = 'v1';
/** 单条草稿上限：超过就不暂存这一条（超大正文不挤掉其它草稿）。 */
const MAX_DRAFT_LENGTH = 1_000_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

let storageOverride: Storage | null | undefined;
/** 写入失败后（配额满等）本次页面会话停用持久化，避免每键都撞墙。 */
let persistenceDisabled = false;
let warned = false;

/** 测试注入：传一个 Storage 假实现；传 null 模拟"存储不可用"；传 undefined 恢复默认（window.sessionStorage）。 */
export function setDraftStorageForTests(storage: Storage | null | undefined): void {
  storageOverride = storage;
  persistenceDisabled = false;
  warned = false;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function getStorage(): Storage | null {
  return storageOverride !== undefined ? storageOverride : defaultStorage();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIdentity(identity: DraftIdentity): boolean {
  if (typeof identity.courseId !== 'string' || !identity.courseId) return false;
  if (identity.step !== 'info' && identity.step !== 'study' && identity.step !== 'understanding') return false;
  if (identity.step === 'info') return true;
  return typeof identity.lessonId === 'string' && Boolean(identity.lessonId) && typeof identity.language === 'string' && Boolean(identity.language);
}

function sameIdentity(left: unknown, right: DraftIdentity): boolean {
  if (!isRecord(left)) return false;
  return (
    left.courseId === right.courseId &&
    left.step === right.step &&
    (left.lessonId ?? undefined) === (right.lessonId ?? undefined) &&
    (left.language ?? undefined) === (right.language ?? undefined)
  );
}

/** 身份 → 存储 key：`lg.bo.course-editor.draft.v1:<courseId>:<step>[:<lessonId>:<language>]`。 */
export function draftKey(identity: DraftIdentity): string {
  const encoded = [identity.courseId, identity.step].map((part) => encodeURIComponent(part));
  if (identity.step !== 'info') {
    encoded.push(encodeURIComponent(identity.lessonId ?? ''), encodeURIComponent(identity.language ?? ''));
  }
  return `${DRAFT_KEY_PREFIX}${KEY_VERSION}:${encoded.join(':')}`;
}

/**
 * 读取一条草稿。严格校验：JSON 损坏、版本不符、身份与 key 不符、字段形状不符都按无草稿处理。
 * 这里不删除坏数据（render 期间只读）；坏条目的删除由 sweepEditorDrafts 在挂载 effect 里统一做。
 */
export function readDraft<T>(identity: DraftIdentity, parse: (raw: unknown) => T | null): StoredDraft<T> | null {
  if (!validIdentity(identity)) return null;
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(draftKey(identity));
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1 || !sameIdentity(value.identity, identity)) return null;
  const base = parse(value.base);
  const draft = parse(value.draft);
  if (base === null || draft === null) return null;
  return {
    v: 1,
    identity,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    base,
    draft,
  };
}

function samePrefixKeys(storage: Storage, prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function updatedAtOf(raw: string | null): number {
  if (raw === null) return 0;
  try {
    const value = JSON.parse(raw) as { updatedAt?: unknown };
    return typeof value.updatedAt === 'number' ? value.updatedAt : 0;
  } catch {
    return 0;
  }
}

/** 配额满时按 updatedAt 淘汰同前缀最旧的一条，给新草稿腾位置。 */
function evictOldest(storage: Storage, protectKey: string): boolean {
  let oldestKey: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const key of samePrefixKeys(storage, DRAFT_KEY_PREFIX)) {
    if (key === protectKey) continue;
    const at = updatedAtOf(storage.getItem(key));
    if (at < oldestAt) {
      oldestAt = at;
      oldestKey = key;
    }
  }
  if (!oldestKey) return false;
  storage.removeItem(oldestKey);
  return true;
}

function safeSet(storage: Storage, key: string, serialized: string): boolean {
  try {
    storage.setItem(key, serialized);
    return true;
  } catch {
    try {
      if (evictOldest(storage, key)) {
        storage.setItem(key, serialized);
        return true;
      }
    } catch {
      /* 仍然写不进去，走统一的停用逻辑 */
    }
    persistenceDisabled = true;
    if (!warned) {
      warned = true;
      console.warn('[course-editor] local draft persistence disabled: sessionStorage write failed');
    }
    return false;
  }
}

/** 写入一条草稿；序列化失败 / 超过单条上限 / 存储不可用时返回 false（不抛）。 */
export function writeDraft<T>(identity: DraftIdentity, value: { base: T; draft: T }, now = Date.now()): boolean {
  if (!validIdentity(identity) || persistenceDisabled) return false;
  const storage = getStorage();
  if (!storage) return false;
  const payload: StoredDraft<T> = { v: 1, identity, updatedAt: now, base: value.base, draft: value.draft };
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (serialized.length > MAX_DRAFT_LENGTH) return false;
  return safeSet(storage, draftKey(identity), serialized);
}

export function removeDraft(identity: DraftIdentity): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(draftKey(identity));
  } catch {
    /* 存储不可用：没有可删的 */
  }
}

/** 退出登录 / 换账号：清掉两种存储里的全部课程编辑器草稿（防御式）。 */
export function clearEditorDrafts(storages?: Storage[]): void {
  const targets = storages ?? defaultStorages();
  for (const storage of targets) {
    try {
      for (const key of samePrefixKeys(storage, DRAFT_KEY_PREFIX)) storage.removeItem(key);
    } catch {
      /* 该存储不可用：跳过 */
    }
  }
}

function defaultStorages(): Storage[] {
  const targets: Storage[] = [];
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) targets.push(window.sessionStorage);
  } catch {
    /* 忽略 */
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) targets.push(window.localStorage);
  } catch {
    /* 忽略 */
  }
  return targets;
}

/**
 * 编辑器挂载时的懒清理：7 天前的、损坏 / 版本不符 / 身份与 key 不符的条目删除；
 * 同前缀超过 50 条时按 updatedAt 从旧到新删到上限。
 */
export function sweepEditorDrafts(now = Date.now()): void {
  const storage = getStorage();
  if (!storage) return;
  const entries: Array<{ key: string; updatedAt: number }> = [];
  for (const key of samePrefixKeys(storage, DRAFT_KEY_PREFIX)) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      return;
    }
    let drop = raw === null;
    let updatedAt = 0;
    if (raw !== null) {
      try {
        const value: unknown = JSON.parse(raw);
        if (isRecord(value)) {
          updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : 0;
          drop =
            value.v !== 1 ||
            !isRecord(value.identity) ||
            draftKey(value.identity as DraftIdentity) !== key ||
            now - updatedAt > MAX_AGE_MS;
        } else {
          drop = true;
        }
      } catch {
        drop = true;
      }
    }
    try {
      if (drop) storage.removeItem(key);
      else entries.push({ key, updatedAt });
    } catch {
      /* 存储不可用：放弃清理 */
      return;
    }
  }
  if (entries.length <= MAX_ENTRIES) return;
  entries.sort((left, right) => left.updatedAt - right.updatedAt);
  for (const entry of entries.slice(0, entries.length - MAX_ENTRIES)) {
    try {
      storage.removeItem(entry.key);
    } catch {
      return;
    }
  }
}
