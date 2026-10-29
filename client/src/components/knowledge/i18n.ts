import { useLocale } from '../../backoffice/lib/navigation'
import { t } from '../../backoffice/lib/i18n/messages'

/** Knowledge 模块文案（接 BackOffice i18n，键在 messages 的 knowledge 命名空间下） */
export function useKText() {
  const locale = useLocale()
  const text = (key: string, vars?: Record<string, string | number>) =>
    t(locale, `knowledge.${key}`, vars)
  return { locale, text }
}
