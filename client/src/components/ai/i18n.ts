import { useLocale } from '../../backoffice/lib/navigation'
import { t } from '../../backoffice/lib/i18n/messages'
import type { AiSegmentKey } from '../../api/ai'

/** AI Tutor 页面文案（接 BackOffice i18n，键在 messages 的 aiTutor 命名空间下） */
export function useAiText() {
  const locale = useLocale()
  const text = (key: string, vars?: Record<string, string | number>) =>
    t(locale, `aiTutor.${key}`, vars)
  const modeLabel = (mode: AiSegmentKey) => text(`modes.${mode}`)
  return { text, modeLabel }
}
