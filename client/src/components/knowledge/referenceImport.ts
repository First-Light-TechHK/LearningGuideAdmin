import type { ReferenceDraft, TeachingEntry, TeachingText } from '../../api/teachingCards'

export type Candidate = {
  file: string; line: number; lesson: string; code: string; names: TeachingText; summary: TeachingText
  kind: 'image' | 'latex'; value: string; issue?: 'missingAsset' | 'multipleAssets'
}
export const normalizeCode = (value: string) => value.trim().normalize('NFKC').toLowerCase()

export function parseReferences(markdown: string, file: string, courseId: string): Candidate[] {
  const rows: Candidate[] = []
  let section: { title: string; line: number; body: string[] } | undefined
  let lesson = ''
  let fence = ''
  const finish = () => {
    if (!section) return
    const { title, line, body } = section
    const match = /^(Exhibit\s+\d+(?:\.\d+)+|[\w.-]*\d[\w.-]*)\s+(.+)$/i.exec(title)
    const code = match?.[1] ?? ''
    const heading = (match?.[2] ?? title).trim()
    const [first, ...rest] = heading.split(/\s*[·｜|]\s*/)
    const names = rest.length || /\p{Script=Han}/u.test(first)
      ? { zh: first.trim(), en: rest.join(' · ').trim() }
      : { zh: '', en: heading }
    const content = body.join('\n')
    const formulaBlock = /^\$\$[ \t]*([\s\S]*?)\$\$[ \t]*$/gm
    const math = [...content.matchAll(formulaBlock)]
    const images = [...content.matchAll(/^!\[.*\]\(([^)\s]+)\)[ \t]*$/gm)]
    const prefix = '/api/files/images/' + courseId + '/'
    const imageUrl = images[0]?.[1] ?? ''
    const image = imageUrl.startsWith(prefix) ? imageUrl.slice(prefix.length) : ''
    const kind = images.length || /^Exhibit\s/i.test(title) ? 'image' : 'latex'
    const value = kind === 'image' ? (/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/i.test(image) ? image : '') : math[0]?.[1].trim() ?? ''
    const summary = { zh: '', en: '' }
    const prose = content.replace(formulaBlock, '').replace(/^!\[.*\]\([^\n]*\)[ \t]*$/gm, '')
    for (const part of prose.trim().split(/\n\s*\n/).filter(Boolean)) {
      const lang = /\p{Script=Han}/u.test(part) ? 'zh' : 'en'
      summary[lang] = [summary[lang], part.trim()].filter(Boolean).join('\n\n')
    }
    const number = /^L(\d+)-/i.exec(code)?.[1] ?? /^Exhibit\s+(\d+)\./i.exec(code)?.[1]
    rows.push({ file, line, lesson: number ? 'Lesson ' + number : lesson, code,
      names, summary, kind, value,
      issue: images.length + math.length > 1 ? 'multipleAssets' : !value ? 'missingAsset' : undefined })
  }
  for (const [index, raw] of markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').entries()) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(raw)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
      continue
    }
    if (marker) { fence = marker[1]; continue }
    const header = /^#{1,6}\s+(.+)$/.exec(raw)
    if (!header) { section?.body.push(raw); continue }
    finish()
    section = undefined
    const title = header[1].trim()
    if (/^Lesson\s+\d+/i.test(title)) lesson = /^Lesson\s+\d+/i.exec(title)![0]
    else if (/^###\s/.test(raw) || /^(?:Exhibit\s+|L\d+-)/i.test(title)) section = { title, line: index + 1, body: [] }
  }
  finish()
  return rows
}

export function matchReference(row: Candidate, entries: TeachingEntry[], deleted: string[]) {
  const code = normalizeCode(row.code)
  const matches = entries.filter(e => [e.draft, e.approved].some(d => d?.type === 'ref_obj' &&
    [d.approvedPayload.code ?? '', ...(d.approvedPayload.aliases ?? [])].some(c => normalizeCode(c) === code)))
  const target = matches[0]
  const asset = target?.draft.approvedPayload.refObjects?.[0]
  const label = target?.draft.approvedPayload.displayName || [target?.draft.approvedPayload.code ?? row.code, row.names.zh, row.names.en].filter(Boolean).join(' · ')
  if (row.issue || !row.value.trim() || !code || code.length > 80 || !row.names.en.trim() || !row.summary.en.trim() ||
    Math.max(row.names.zh.length, row.names.en.length) > 100 || Math.max(row.summary.zh.length, row.summary.en.length) > 2000 ||
    label.length > 350 || /[[\]\r\n\\]/.test(label) || (row.kind === 'latex' && (row.value.length > 2000 || /[$<>]/.test(row.value))) ||
    matches.length > 1 || (target && asset?.kind !== row.kind)) return { status: 'conflict' as const, target }
  if (!target) return { status: deleted.some(c => normalizeCode(c) === code) ? 'recreate' as const : 'new' as const, target }
  const { conceptLabel, summary } = target.draft.bilingual
  const same = asset?.value === row.value && conceptLabel.en === row.names.en && conceptLabel.zh === row.names.zh &&
    summary.en === row.summary.en && summary.zh === row.summary.zh
  return { status: same ? 'same' as const : 'update' as const, target }
}

export function referenceDraft(row: Candidate, target?: TeachingEntry): ReferenceDraft {
  return { type: 'ref_obj', bilingual: { conceptLabel: row.names, summary: row.summary },
    approvedPayload: { code: target?.draft.approvedPayload.code ?? row.code, displayName: target?.draft.approvedPayload.displayName,
      refObjects: [{ kind: row.kind, value: row.value }] } }
}
