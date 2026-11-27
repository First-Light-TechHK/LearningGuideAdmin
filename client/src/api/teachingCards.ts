import { http } from './client'

export type TeachingText = { en: string; zh: string }
export type TeachingList = { en: string[]; zh: string[] }
export type TeachingRef = { id: string; kind: 'image' | 'latex'; label: string; value: string; requires: string[]; code?: string }
export type TeachingDraft = {
  type: string
  topic: string
  conceptId: string
  canonicalPoint: string
  bilingual: { conceptLabel: TeachingText; summary: TeachingText; triggers: TeachingList }
  approvedPayload: { definitionName?: string; sourcePageId?: string; question?: string; code?: string; aliases?: string[]; displayName?: string; answerMd: string; refObjects?: TeachingRef[] }
  useWhen: string[]
  doNotUseWhen: string[]
  evidence: string[]
  links: string[]
  priority: number
}

export function definitionBody(draft: TeachingDraft) {
  if (draft.approvedPayload.definitionName !== undefined) return draft.approvedPayload.answerMd
  return draft.approvedPayload.answerMd || draft.canonicalPoint || draft.bilingual.summary.en || draft.bilingual.summary.zh
}

export function definitionFields(draft: TeachingDraft) {
  const prose = definitionBody(draft).replace(/!?\[[^\]]*\]\([^)]*\)|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, '')
  return {
    definitionExcerpt: draft.evidence[0] ?? '',
    definitionName: draft.approvedPayload.definitionName ?? (draft.bilingual.conceptLabel.en || draft.bilingual.conceptLabel.zh),
    definitionBody: /\p{L}/u.test(prose) ? prose : '',
  }
}

export type TeachingEntry = {
  id: string
  createdAt: string | null
  additionPosition: number
  revision: number
  draft: TeachingDraft
  approved: TeachingDraft | null
  approvedRevision: number | null
}

export type ReferenceDraft = {
  type: 'ref_obj'
  bilingual: Pick<TeachingDraft['bilingual'], 'conceptLabel' | 'summary'>
  approvedPayload: { code: string; displayName?: string; refObjects: Pick<TeachingRef, 'kind' | 'value'>[] }
}

export type DeleteBlocker = { id: string; source: string; kind: 'draft' | 'approved' | 'changed' | 'wiki' | 'base' }
type DeleteItem = Pick<TeachingEntry, 'id' | 'revision'>

const base = (courseId: string) => `/courses/${encodeURIComponent(courseId)}/teaching-cards`

function workspaceHeaders(stamp?: string) {
  return { headers: { 'X-Workspace-Stamp': stamp } }
}

export const teachingCardsApi = {
  list: (courseId: string, onStamp?: (stamp: string) => void) =>
    http.get<TeachingEntry[]>(base(courseId)).then(({ data, headers }) => {
      onStamp?.(headers['x-workspace-stamp'])
      return data
    }),
  references: (courseId: string, signal?: AbortSignal) =>
    http.get<TeachingRef[]>(`/courses/${encodeURIComponent(courseId)}/teaching-references`, { signal }).then(({ data }) => data),
  deletedReferenceCodes: (courseId: string) =>
    http.get<string[]>(base(courseId) + '/import/deleted-codes').then(({ data }) => data),
  importReferences: (courseId: string, items: { id?: string; revision?: number; draft: ReferenceDraft; recreate?: boolean }[]) => {
    const method = items.every(item => item.id) ? 'patch' : 'post'
    return http[method]<{ saved: number }>(base(courseId) + '/import/references', { items }, { timeout: 45000 }).then(({ data }) => data)
  },
  deletionPreview: (courseId: string, items: DeleteItem[], stamp?: string) =>
    http.post<{ blockers: DeleteBlocker[] }>(base(courseId) + '/deletion-preview', { items }, workspaceHeaders(stamp)).then(({ data }) => data),
  deleteSelection: (courseId: string, items: DeleteItem[], stamp?: string) =>
    http.delete<{ blockers: DeleteBlocker[] }>(base(courseId), { ...workspaceHeaders(stamp), data: { items } }).then(({ data }) => data),
  create: (courseId: string, draft: TeachingDraft, stamp?: string) =>
    http.post<TeachingEntry>(base(courseId), draft, workspaceHeaders(stamp)).then(({ data }) => data),
  update: (courseId: string, id: string, revision: number, draft: TeachingDraft, stamp?: string) =>
    http.patch<TeachingEntry>(`${base(courseId)}/${encodeURIComponent(id)}`, { revision, draft }, workspaceHeaders(stamp)).then(({ data }) => data),
}
