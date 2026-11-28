import { useRef, useState } from 'react'
import { App, Button, Typography } from '../ui'
import { knowledgeApi, type ReleasePackagePreview } from '../../api/knowledge'
import { useKText } from './i18n'

export function ReleasePackageUpload({ courseId, disabled, acquire, onImported }: {
  courseId: string
  disabled: boolean
  acquire: () => (() => void) | null
  onImported: () => Promise<void>
}) {
  const { text } = useKText()
  const { message } = App.useApp()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [filename, setFilename] = useState('')
  const [pending, setPending] = useState<{file: File; report: ReleasePackagePreview} | null>(null)
  const [error, setError] = useState('')
  const inspect = async (file: File) => {
    const unlock = acquire()
    if (!unlock) return
    setBusy(true); setError(''); setPending(null); setFilename(file.name)
    try {
      const report = await knowledgeApi.importReleasePackage(courseId, file, 'preview')
      setPending({file, report})
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false); unlock() }
  }
  const apply = async () => {
    if (!pending || busy) return
    const unlock = acquire()
    if (!unlock) return
    setBusy(true); setError('')
    try {
      const result = await knowledgeApi.importReleasePackage(courseId, pending.file, 'apply')
      setPending(null)
      setFilename('')
      message.success(text(result.duplicate ? 'publish.packageExists' : 'publish.packageImported'))
      await onImported()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false); unlock() }
  }
  return <section className="release-history-package teaching-transfer-section teaching-transfer-inset">
    <div className="release-history-upload">
      <strong>{text('publish.uploadPackage')}</strong>
      <input ref={input} type="file" accept=".zip" disabled={disabled} hidden aria-label={text('publish.uploadPackage')}
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void inspect(file) }} />
      <Button size="small" disabled={disabled} loading={busy} onClick={() => input.current?.click()}>{text('common.chooseFile')}</Button>
      <span className="teaching-transfer-muted">{filename || text('common.noFileSelected')}</span>
    </div>
    {error && <Typography.Paragraph role="alert" type="danger">{error}</Typography.Paragraph>}
    {pending && <>
      <Typography.Paragraph>{text('publish.packageCounts', {version: pending.report.versionTag, course: pending.report.sourceCourse,
        pages: pending.report.pages, cards: pending.report.cards, images: pending.report.images})}</Typography.Paragraph>
      {!!pending.report.types.length && <Typography.Paragraph>{pending.report.types.map(({type,count}) =>
        (type==='deleted'?text('publish.packageDeleted'):text('teaching.type.'+type))+' × '+count).join(' · ')}</Typography.Paragraph>}
      {!!pending.report.conflicts.length && <Typography.Paragraph type="warning">
        {text('publish.packageConflicts', {codes:pending.report.conflicts.join(', ')})}</Typography.Paragraph>}
      {pending.report.duplicate ? <Typography.Text>{text('publish.packageExists')}</Typography.Text> :
        <Button type="primary" disabled={disabled} loading={busy} onClick={() => void apply()}>{text('publish.confirmPackage')}</Button>}
    </>}
  </section>
}
