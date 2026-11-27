import { useState } from 'react'
import { App, Button, Typography } from '../ui'
import { knowledgeApi, type ReleasePackagePreview } from '../../api/knowledge'
import { useKText } from './i18n'

export function ReleasePackageUpload({ courseId, onImported }: { courseId: string; onImported: () => Promise<void> }) {
  const { text } = useKText()
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{file: File; report: ReleasePackagePreview} | null>(null)
  const [error, setError] = useState('')
  const inspect = async (file: File) => {
    setBusy(true); setError(''); setPending(null)
    try {
      const report = await knowledgeApi.importReleasePackage(courseId, file, 'preview')
      setPending({file, report})
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  const apply = async () => {
    if (!pending || busy) return
    setBusy(true); setError('')
    try {
      const result = await knowledgeApi.importReleasePackage(courseId, pending.file, 'apply')
      setPending(null)
      message.success(text(result.duplicate ? 'publish.packageExists' : 'publish.packageImported'))
      await onImported()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <section style={{marginBottom: 16}}>
    <label>{text('publish.uploadPackage')} <input type="file" accept=".zip" disabled={busy}
      onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void inspect(file) }} /></label>
    {error && <Typography.Paragraph role="alert" type="danger">{error}</Typography.Paragraph>}
    {pending && <>
      <Typography.Paragraph>{text('publish.packageCounts', {version: pending.report.versionTag, course: pending.report.sourceCourse,
        pages: pending.report.pages, cards: pending.report.cards, images: pending.report.images})}</Typography.Paragraph>
      {!!pending.report.types.length && <Typography.Paragraph>{pending.report.types.map(({type,count}) =>
        (type==='deleted'?text('publish.packageDeleted'):text('teaching.type.'+type))+' × '+count).join(' · ')}</Typography.Paragraph>}
      {!!pending.report.conflicts.length && <Typography.Paragraph type="warning">
        {text('publish.packageConflicts', {codes:pending.report.conflicts.join(', ')})}</Typography.Paragraph>}
      {pending.report.duplicate ? <Typography.Text>{text('publish.packageExists')}</Typography.Text> :
        <Button type="primary" loading={busy} onClick={() => void apply()}>{text('publish.confirmPackage')}</Button>}
    </>}
  </section>
}
