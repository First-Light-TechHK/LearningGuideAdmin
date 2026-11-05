import { buttonStyle } from '../pages/course-editor/shared-utils';
import { formatBytes } from '../lib/upload'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'

const TONES = {
  active: { bar: '#1D6BFF', bg: '#EEF3FF', border: '#D7E3FF', text: '#2B58C8' },
  success: { bar: '#1E7A3C', bg: '#E7F6EC', border: '#C7E8D3', text: '#1E7A3C' },
  error: { bar: '#b42318', bg: '#FDECEC', border: '#F0C2BE', text: '#b42318' },
  muted: { bar: '#8A93A5', bg: '#F5F7FA', border: '#E1E6EF', text: '#5A6577' },
} as const

/**
 * 上传/处理进度条（大文件上传的基础反馈：百分比、已传/总大小、速度与剩余时间、取消/重试）。
 */
export function UploadProgress({
  pct,
  tone = 'active',
  title,
  detail,
  loaded,
  total,
  elapsedMs,
  onCancel,
  cancelLabel,
}: {
  pct?: number
  tone?: keyof typeof TONES
  title: string
  detail?: string
  loaded?: number
  total?: number
  elapsedMs?: number
  onCancel?: () => void
  cancelLabel?: string
}) {
  const locale = useLocale()
  const palette = TONES[tone]
  const percent = typeof pct === 'number' ? Math.max(0, Math.min(100, Math.round(pct))) : null
  const speed =
    loaded && total && elapsedMs && elapsedMs > 800 ? loaded / (elapsedMs / 1000) : null
  const remaining =
    speed && loaded && total && speed > 0 ? Math.max(0, (total - loaded) / speed) : null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        borderRadius: 10,
        padding: '10px 12px',
        marginTop: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: palette.text }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {percent !== null && <span style={{ fontSize: 13, fontWeight: 600, color: palette.text }}>{percent}%</span>}
          {onCancel && (
            <button type="button" style={{ ...buttonStyle, padding: '3px 10px', fontSize: 12 }} onClick={onCancel}>
              {cancelLabel ?? t(locale, 'common.cancel')}
            </button>
          )}
        </span>
      </div>
      {percent !== null && (
        <div
          style={{ height: 6, background: '#fff', borderRadius: 999, overflow: 'hidden', marginTop: 8 }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            style={{
              width: `${percent}%`,
              height: '100%',
              background: palette.bar,
              transition: 'width 0.2s ease',
            }}
          />
        </div>
      )}
      {(detail || speed) && (
        <div style={{ fontSize: 12, color: palette.text, opacity: 0.85, marginTop: 6 }}>
          {loaded !== undefined && total !== undefined && total > 0 && (
            <span>
              {formatBytes(loaded)} / {formatBytes(total)}
            </span>
          )}
          {speed ? <span> · {formatBytes(speed)}/s</span> : null}
          {remaining !== null && remaining > 1 ? <span> · {t(locale, 'common.remainingSeconds', { seconds: Math.ceil(remaining) })}</span> : null}
          {detail ? <span> · {detail}</span> : null}
        </div>
      )}
    </div>
  )
}
