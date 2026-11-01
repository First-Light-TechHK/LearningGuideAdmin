import type { FaqDraft } from './helpdeskFaqs'

/**
 * 卡片内容的版本（像 Claude Artifact）：每次「AI 按指令改」是一个新版本；人手改的连续输入并成一个版本，
 * 直到下一次 AI 改或切换版本。可以前后切换；在旧版本上再改，新版本接在最后（不丢任何版本）。
 * 只在浏览器里：点「保存并批准」时存当前版本，之前的版本不上服务器（服务器的改动记录另算）。
 */

export const CARD_TEXT_FIELDS = ['questionZh', 'answerZh', 'questionEn', 'answerEn', 'category'] as const
export type CardTextField = (typeof CARD_TEXT_FIELDS)[number]

export type VersionOrigin = 'start' | 'manual' | 'ai'

export type CardVersion = {
  n: number
  origin: VersionOrigin
  draft: FaqDraft
  /** AI 版本：运营说的话。 */
  instruction?: string
  /** 和上一个版本比改了哪些字段（AI 版本用来高亮）。 */
  changed: CardTextField[]
}

export type CardHistory = { versions: CardVersion[]; at: number }

export function startHistory(draft: FaqDraft): CardHistory {
  return { versions: [{ n: 1, origin: 'start', draft, changed: [] }], at: 0 }
}

export function currentVersion(history: CardHistory): CardVersion {
  return history.versions[history.at]
}

export function changedFields(before: FaqDraft, after: FaqDraft): CardTextField[] {
  return CARD_TEXT_FIELDS.filter((field) => (before[field] ?? '') !== (after[field] ?? ''))
}

function append(history: CardHistory, version: Omit<CardVersion, 'n'>): CardHistory {
  const versions = [...history.versions, { ...version, n: history.versions.length + 1 }]
  return { versions, at: versions.length - 1 }
}

/** 人手改：正停在最后一个人手版本上就并进去，否则新开一个人手版本。 */
export function editHistory(history: CardHistory, patch: Partial<FaqDraft>): CardHistory {
  const current = currentVersion(history)
  const draft = { ...current.draft, ...patch }
  const isLast = history.at === history.versions.length - 1
  if (isLast && current.origin === 'manual') {
    const previous = history.versions[history.at - 1]
    const versions = history.versions.slice()
    versions[history.at] = { ...current, draft, changed: previous ? changedFields(previous.draft, draft) : [] }
    return { versions, at: history.at }
  }
  return append(history, { origin: 'manual', draft, changed: changedFields(current.draft, draft) })
}

/** AI 按指令改完：没改任何东西就不加版本（返回 null，界面说「AI 没有改动」）。 */
export function aiHistory(history: CardHistory, draft: Partial<FaqDraft>, instruction: string): CardHistory | null {
  const current = currentVersion(history)
  const next = { ...current.draft, ...draft }
  const changed = changedFields(current.draft, next)
  if (changed.length === 0) return null
  return append(history, { origin: 'ai', draft: next, instruction, changed })
}

export function goTo(history: CardHistory, index: number): CardHistory {
  return { ...history, at: Math.min(history.versions.length - 1, Math.max(0, index)) }
}

/** 换掉第一个版本（服务器上的卡变了，比如 409 之后重新读）：之后的版本保留。 */
export function rebase(history: CardHistory, draft: FaqDraft): CardHistory {
  const versions = history.versions.slice()
  versions[0] = { ...versions[0], draft }
  return { ...history, versions }
}

/** 选中的一段文字（只让 AI 改这一段）；空选区或越界都当没选。 */
export type TextSelection = { field: Exclude<CardTextField, 'category'>; start: number; end: number }

export function cleanSelection(draft: FaqDraft, selection: TextSelection | null): TextSelection | null {
  if (!selection) return null
  const text = draft[selection.field] ?? ''
  const start = Math.max(0, Math.min(selection.start, selection.end))
  const end = Math.min(text.length, Math.max(selection.start, selection.end))
  return end - start >= 2 ? { field: selection.field, start, end } : null
}

export const INSTRUCTION_MAX = 500
