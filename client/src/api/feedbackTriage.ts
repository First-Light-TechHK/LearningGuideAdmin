import type { FeedbackRecord, FeedbackStatus } from './feedback'

export const issues = ['Knowledge gap', 'Teaching strategy', 'Retrieval issue', 'Model or technical issue', 'No issue', 'Other'] as const
export const outcomes = ['Classified only', 'Knowledge updated', 'Prompt updated', 'AI technical review', 'No action needed'] as const
export interface TriageDraft { issue: string; outcome: string; note: string; change: string; verification: string }
export interface TriageHistory { at: string; actor: string; from: FeedbackStatus; to: FeedbackStatus; draft: TriageDraft }
export interface TriageState extends TriageDraft { status: FeedbackStatus; resolvedAt: string | null; history: TriageHistory[] }
export type TriageStore = Record<string, TriageState>
export const blankTriage: TriageDraft = { issue: '', outcome: '', note: '', change: '', verification: '' }
const statuses = ['New', 'Triaged', 'Applied', 'Dismissed']
const key = (owner: string) => `aitutor.feedback.v1.${encodeURIComponent(owner)}`
function validDraft(value: unknown): value is TriageDraft {
  if (!value || typeof value !== 'object') return false
  return Object.keys(blankTriage).every((field) => typeof (value as Record<string, unknown>)[field] === 'string')
}
export function loadTriage(owner: string): TriageStore {
  const raw = localStorage.getItem(key(owner))
  if (raw === null) return {}
  const parsed = JSON.parse(raw)
  if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) throw new Error('storage')
  for (const value of Object.values(parsed.records) as TriageState[]) {
    if (!validDraft(value) || !statuses.includes(value.status) || !Array.isArray(value.history) ||
      !(value.resolvedAt === null || (typeof value.resolvedAt === 'string' && Number.isFinite(Date.parse(value.resolvedAt)))) ||
      !value.history.every((event) => event && typeof event.actor === 'string' && Number.isFinite(Date.parse(event.at)) && statuses.includes(event.from) && statuses.includes(event.to) && validDraft(event.draft))) throw new Error('storage')
  }
  for (const value of Object.values(parsed.records) as TriageState[]) {
    if (!value.history.length) throw new Error('storage')
    const closed = value.status === 'Applied' || value.status === 'Dismissed'
    if (closed !== (value.resolvedAt !== null)) throw new Error('storage')
    for (let i = 0; i < value.history.length; i++) {
      const event = value.history[i]
      const prior = value.history[i - 1]
      if (prior && prior.to !== event.from) throw new Error('storage')
      try {
        transitionTriage({ status: event.from } as FeedbackRecord, undefined, event.draft, event.to, event.actor, event.at)
      } catch { throw new Error('storage') }
    }
    const last = value.history[value.history.length - 1]
    if (last.to !== value.status || (closed && value.resolvedAt !== last.at) ||
      Object.keys(blankTriage).some((k) => value[k as keyof TriageDraft] !== last.draft[k as keyof TriageDraft])) throw new Error('storage')
  }
  return parsed.records
}
export function saveTriage(owner: string, records: TriageStore) {
  localStorage.setItem(key(owner), JSON.stringify({ version: 1, records }))
}
export function transitionTriage(record: FeedbackRecord, previous: TriageState | undefined, draft: TriageDraft, target: FeedbackStatus, actor: string, at = new Date().toISOString()): TriageState {
  const from = previous?.status ?? record.status
  const clean = Object.fromEntries(Object.keys(blankTriage).map((k) => [k, draft[k as keyof TriageDraft].trim()])) as unknown as TriageDraft
  if ((clean.issue && !issues.includes(clean.issue as typeof issues[number])) || (clean.outcome && !outcomes.includes(clean.outcome as typeof outcomes[number]))) throw new Error('required')
  const closed = from === 'Applied' || from === 'Dismissed'
  if ((closed && target !== 'Triaged') || (!closed && target === 'New') || (target === 'Applied' && from !== 'Triaged')) throw new Error('transition')
  if (closed) { if (!clean.note) throw new Error('reason') }
  else {
    if (!issues.includes(clean.issue as typeof issues[number]) || !outcomes.includes(clean.outcome as typeof outcomes[number])) throw new Error('required')
    if (target === 'Dismissed' && (!clean.note || clean.outcome !== 'No action needed')) throw new Error('reason')
    if (target === 'Applied' && (!clean.change || !clean.verification || !['Knowledge updated', 'Prompt updated'].includes(clean.outcome))) throw new Error('evidence')
    if (target === 'Triaged' && clean.outcome === 'No action needed') throw new Error('transition')
  }
  return { ...clean, status: target, resolvedAt: target === 'Applied' || target === 'Dismissed' ? at : null,
    history: [...(previous?.history ?? []), { at, actor, from, to: target, draft: { ...clean } }] }
}
