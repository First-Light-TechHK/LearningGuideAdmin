import { http } from './client'
import { DownloadResponseError, fetchFileDownload } from './fileDownload'

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
    definitionName: draft.approvedPayload.definitionName ?? (draft.bilingual.conceptLabel.en || draft.bilingual.conceptLabel.zh),
    definitionBody: /\p{L}/u.test(prose) ? prose : '',
  }
}

export function referenceNamePreview(code: string, name: string) {
  return [code.trim().normalize('NFKC'), name.trim()].filter(Boolean).join(' · ')
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
  approvedPayload: { code: string; displayName?: string; aliases?: string[]; refObjects: Pick<TeachingRef, 'kind' | 'value'>[] }
}

export type DeleteBlocker = { id: string; source: string; kind: 'draft' | 'approved' | 'changed' | 'wiki' | 'base' }
type DeleteItem = Pick<TeachingEntry, 'id' | 'revision'>
export const teachingSheetNames = { concept: 'Definitions', professor_qa: 'Professor Q&A' } as const
export type TeachingSheetKind = keyof typeof teachingSheetNames
export type TeachingImportKind = TeachingSheetKind | 'image' | 'latex'
export type TeachingTransferKind = 'workbook' | 'image' | 'latex'
export type TeachingSheetSelection = { kind: TeachingSheetKind; ids: string[] }
export type TeachingSheetReview = {
  kind: TeachingSheetKind
  name: string
  invalid?: true
  targets: { id: string; revision: number; title: string; values: string[] }[]
  rows: {
    row: number
    values: string[]
    status: 'new' | 'update' | 'choose' | 'same' | 'invalid' | 'duplicate' | 'rename'
    sourcePage: string | null
    issues: { column: number; code: string; detail?: string }[]
    targetId: string | null
    suggestedIds?: string[]
    references?: TeachingRef[]
    binding?: string
  }[]
}
export type TeachingWorkbookReview = { stamp: string; sheets: TeachingSheetReview[]; skippedSheets: string[] }
export type SheetPick = { kind: TeachingSheetKind; row: number; id?: string; revision?: number; binding?: string }

export type ReferenceDocumentRow = {
  code: string; names: TeachingText; summary: TeachingText; displayName?: string; aliases?: string[]
  kind: 'image' | 'latex'; value: string
}

const base = (courseId: string) => `/courses/${encodeURIComponent(courseId)}/teaching-cards`

function workspaceHeaders(stamp?: string) {
  return { headers: { 'X-Workspace-Stamp': stamp } }
}

export const teachingCardsApi = {
  downloadWorkbook: (courseId: string, sheets: TeachingSheetSelection[]) =>
    fetchFileDownload('/api' + base(courseId) + '/export/workbook', 'Teaching Entries.xlsx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheets }),
    }),
  download: async (courseId: string, kind: TeachingImportKind, ids: string[], locale: string) => {
    const extension = kind === 'image' || kind === 'latex' ? 'docx' : 'xlsx'
    try {
      return await fetchFileDownload('/api' + base(courseId) + '/export/' + kind + '?lang=' + encodeURIComponent(locale),
        'teaching-' + kind + '.' + extension, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
        })
    } catch (error) {
      if (error instanceof DownloadResponseError && error.status === 413 && ids.length > 1) return null
      throw error
    }
  },
  previewReferenceDocument: (courseId: string, kind: 'image' | 'latex', file: File) => {
    const form = new FormData()
    form.append('file',file)
    return http.post<{markdown?:string;rows?:ReferenceDocumentRow[];token?:string}>(base(courseId)+'/reference-documents/'+kind+'/preview',form,
      {timeout:60000}).then(({data})=>data)
  },
  finishReferenceDocuments: (courseId: string, tokens: string[]) =>
    http.post(base(courseId)+'/reference-documents/finish',{tokens},{timeout:60000}).then(()=>undefined),
  referenceUsage: (courseId: string, id: string, revision: number) =>
    http.get<{blockers:DeleteBlocker[]}>(base(courseId)+'/'+encodeURIComponent(id)+'/reference-usage',{params:{revision}}).then(({data})=>data.blockers),
  templateUrl: (courseId: string, kind: TeachingImportKind | 'workbook', locale: string) =>
    '/api' + base(courseId) + '/templates/' + kind + '?lang=' + encodeURIComponent(locale),
  previewWorkbook: (courseId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return http.post<TeachingWorkbookReview>(base(courseId) + '/sheets/workbook/preview', form,
      { timeout: 45000 }).then(({ data }) => data)
  },
  applyWorkbook: (courseId: string, file: File, picks: SheetPick[], stamp: string) => {
    const form = new FormData()
    form.append('file', file)
    form.append('selection', JSON.stringify(picks))
    const method = picks.every(pick => pick.id) ? 'patch' : 'post'
    return http[method]<{ saved: number }>(base(courseId) + '/sheets/workbook/apply', form,
      { ...workspaceHeaders(stamp), timeout: 45000 }).then(({ data }) => data)
  },
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
