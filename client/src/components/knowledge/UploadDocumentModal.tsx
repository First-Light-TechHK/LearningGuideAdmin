import { useRef, useState } from 'react'
import { App, Button, Modal, Upload } from '../ui'
import { FileTextOutlined, InboxOutlined } from '@ant-design/icons'
import {
  knowledgeApi,
  UPLOAD_ALLOWED_EXTENSIONS,
  UPLOAD_MAX_FILE_SIZE,
  type ConvertedDocument,
} from '../../api/knowledge'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { tokens } from '../../theme/tokens'
import { useKText } from './i18n'

/**
 * 「上传并解析」两步弹窗（§3.2.3）：
 * ① 选择文件（拖拽/Browse，前端预校验白名单+15MB）
 * ② POST /api/files/convert 本地转换 → 预览 Markdown → Import 经 §5.1.2 建页
 * 转换阶段不建页、Cancel 不落任何数据。
 * 2026-10-16 扁平化：目标为 Course（无 Lesson 层）。
 */
export function UploadDocumentModal({
  target,
  onClose,
}: {
  /** 上传目标 Course；null 关闭 */
  target: { courseId: string; courseTitle: string } | null
  onClose: () => void
}) {
  const { message } = App.useApp()
  const { text } = useKText()
  const importDocument = useKnowledgeStore((s) => s.importDocument)
  const [file, setFile] = useState<File | null>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [converting, setConverting] = useState(false)
  const [converted, setConverted] = useState<ConvertedDocument | null>(null)
  const [importing, setImporting] = useState(false)
  /** 代际号：关闭弹窗后丢弃 in-flight 转换结果（防陈旧预览/竞态） */
  const genRef = useRef(0)

  const close = () => {
    genRef.current += 1
    setFile(null)
    setStep(1)
    setConverted(null)
    onClose()
  }

  /** §10.1 前端预校验（后端二次校验） */
  const preCheck = (f: File): boolean => {
    const dot = f.name.lastIndexOf('.')
    const ext = dot > 0 ? f.name.slice(dot).toLowerCase() : ''
    if (!(UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      message.error(
        text('upload.unsupportedFormat', {
          ext: ext || text('upload.unknownExt'),
          list: UPLOAD_ALLOWED_EXTENSIONS.join(' / '),
        }),
      )
      return false
    }
    if (f.size > UPLOAD_MAX_FILE_SIZE) {
      message.error(text('upload.tooLarge'))
      return false
    }
    return true
  }

  const goParse = async () => {
    if (!file) return
    const gen = genRef.current
    setConverting(true)
    try {
      const doc = await knowledgeApi.convertFile(file)
      if (gen !== genRef.current) return // 弹窗已关闭/重开，丢弃陈旧结果
      setConverted(doc)
      setStep(2)
    } catch (e) {
      if (gen === genRef.current) message.error((e as Error).message)
    } finally {
      if (gen === genRef.current) setConverting(false)
    }
  }

  const doImport = async () => {
    if (!file || !converted || !target) return
    setImporting(true)
    try {
      await importDocument(target.courseId, {
        title: converted.title,
        contentMd: converted.markdown,
      })
      message.success(text('upload.imported', { title: converted.title }))
      close()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={!!target}
      title={text('upload.title')}
      onCancel={close}
      destroyOnHidden
      width={720}
      footer={
        <div style={{ display: 'flex', gap: tokens.spacing.sm, justifyContent: 'flex-end' }}>
          <Button onClick={close}>{text('common.cancel')}</Button>
          {step === 1 ? (
            <Button type="primary" disabled={!file} loading={converting} onClick={goParse}>
              {text('upload.next')}
            </Button>
          ) : (
            <Button type="primary" loading={importing} onClick={doImport}>
              {text('upload.import')}
            </Button>
          )}
        </div>
      }
    >
      {target && (
        <div
          style={{
            fontSize: tokens.fontSize.md,
            color: tokens.color.text.tertiary,
            marginBottom: tokens.spacing.sm,
          }}
        >
          {text('upload.targetCourse', { title: target.courseTitle })}
        </div>
      )}
      {step === 1 ? (
        <>
          <Upload.Dragger
            maxCount={1}
            showUploadList={false}
            accept={UPLOAD_ALLOWED_EXTENSIONS.join(',')}
            beforeUpload={(f) => {
              if (preCheck(f)) setFile(f)
              return false // 手动控制：不自动上传
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p style={{ margin: '4px 0' }}>
              {text('upload.dragHint')}
            </p>
            <p
              style={{
                color: tokens.color.text.tertiary,
                fontSize: tokens.fontSize.md,
                margin: 0,
              }}
            >
              {text('upload.formatHint', {
                list: UPLOAD_ALLOWED_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(text('listSeparator')),
              })}
            </p>
          </Upload.Dragger>
          {file && (
            <p style={{ margin: `${tokens.spacing.sm}px 0 0`, color: tokens.color.primary }}>
              <FileTextOutlined /> {file.name}
            </p>
          )}
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 8px', color: tokens.color.primary }}>
            <FileTextOutlined /> {file?.name}
          </p>
          <div
            style={{
              border: `1px dashed ${tokens.color.primaryBorder}`,
              borderRadius: tokens.radius.md,
              maxHeight: 420,
              overflow: 'auto',
              padding: tokens.spacing.md,
              background: tokens.color.bg.subtle,
            }}
          >
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontSize: tokens.fontSize.md,
                fontFamily: 'inherit',
              }}
            >
              {converted?.markdown}
            </pre>
          </div>
        </>
      )}
    </Modal>
  )
}
