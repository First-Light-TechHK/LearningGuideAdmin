/**
 * 草稿脏/净判断的唯一实现（P73：一个语义一个检查器）。
 * 比较方式与 6a833b2 的 mergeDraft 一致：JSON.stringify 逐字段比较。
 */
export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 用户改过（与基线不同）的字段保留用户值，没改过的跟随最新服务器值。 */
export function keepIfDirty<T>(mine: T, before: T, fresh: T): T {
  return sameValue(mine, before) ? fresh : mine;
}

export function dirtyFields<T extends object>(draft: T, base: T): string[] {
  const keys = new Set([...Object.keys(draft), ...Object.keys(base)]);
  return [...keys].filter((key) => !sameValue((draft as Record<string, unknown>)[key], (base as Record<string, unknown>)[key]));
}

export function isDirty<T extends object>(draft: T, base: T): boolean {
  return dirtyFields(draft, base).length > 0;
}
