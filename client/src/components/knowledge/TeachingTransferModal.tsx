import { useState } from 'react'
import { Modal } from '../ui'
import { teachingSheetNames, type TeachingImportKind, type TeachingSheetKind, type TeachingTransferKind } from '../../api/teachingCards'
import { useKText } from './i18n'
import { TeachingTransferProgress, TeachingTransferSection, TeachingTransferStep } from './TeachingTransferStep'
import { TeachingSheetImport } from './TeachingSheetImportModal'
import { ReferenceImport } from './ReferenceImportModal'
import { TeachingDownload } from './TeachingDownloadModal'
import './TeachingTransferModal.css'

const kinds = ['workbook', 'latex', 'image'] as const
const excelKinds = Object.keys(teachingSheetNames) as TeachingSheetKind[]

type Props = {
  mode: 'import' | 'download'
  courseId: string
  courseTitle: string
  canCreate: boolean
  entriesFor: (kind: TeachingImportKind) => { id: string; title: string }[]
  close: () => void
  saved: () => void
}

export function TeachingTransferModal({ mode, courseId, courseTitle, canCreate, entriesFor, close, saved }: Props) {
  const { text } = useKText()
  const t = (key: string) => text('batchTeaching.' + key)
  const [step, setStep] = useState(0)
  const [kind, setKind] = useState<TeachingTransferKind | null>(null)
  const [busy, setBusy] = useState(false)
  const importing = mode === 'import'
  const stages = importing
    ? ['stepType', 'stepFile', 'stepImportConfirm']
    : ['stepType', 'stepEntries', 'stepDownloadConfirm']
  const content = {
    courseId,
    stage: step === 2 ? 'confirm' as const : 'prepare' as const,
    busy,
    setBusy,
    back: () => setStep(current => current - 1),
    confirm: () => setStep(2),
    close,
  }

  return <Modal open centered width={600} title={t(importing ? 'importTitle' : 'downloadTitle')} footer={null}
    keyboard={!busy} closable={!busy} maskClosable={false} onCancel={() => { if (!busy) close() }}>
    <TeachingTransferProgress labels={stages.map(t)} step={step} />
    <p className="teaching-transfer-course"><strong>{courseTitle}</strong> {t('savedWorkspace')}{step > 0 && kind && <> / {t('kind.' + kind)}</>}</p>
    {step === 0 && <TeachingTransferStep close={close} action={() => setStep(1)} disabled={!kind} label={t('stepNext')}>
      <TeachingTransferSection title={t('entryType')}>
        <fieldset className="teaching-transfer-kinds" aria-label={t('entryType')}>
          {kinds.map(option => <label key={option}>
            <input type="radio" name="teaching-transfer-kind" value={option} checked={kind === option}
              onChange={() => setKind(option)} />
            {t('kind.' + option)}
            <small>{t(option === 'workbook' ? 'excelFormat' : 'wordFormat')}</small>
          </label>)}
        </fieldset>
      </TeachingTransferSection>
    </TeachingTransferStep>}
    {kind && <div key={kind} hidden={step === 0}>
      {!importing ? <TeachingDownload {...content} kind={kind}
        groups={(kind === 'workbook' ? excelKinds : [kind]).map(kind => ({ kind, entries: entriesFor(kind) }))} /> :
        kind === 'workbook' ? <TeachingSheetImport {...content} canCreate={canCreate} saved={saved} /> :
          <ReferenceImport {...content} kind={kind} canCreate={canCreate} saved={saved} />}
    </div>}
  </Modal>
}
