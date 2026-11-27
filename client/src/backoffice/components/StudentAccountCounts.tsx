import type { StudentList } from '../contracts/students'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

const metrics = [
  { key: 'total', label: 'students.countTotal', helper: 'students.countTotalHelp' },
  { key: 'active', label: 'students.countActive', helper: 'students.countActiveHelp' },
  { key: 'inactive', label: 'students.countInactive', helper: 'students.countInactiveHelp' },
] as const

/** Global account totals supplied by the student list API, independent of filters. */
export function StudentAccountCounts({ locale, counts }: { locale: Locale; counts: StudentList['counts'] }) {
  return <dl className="smAccountCounts" data-testid="student-account-counts">
    {metrics.map(({ key, label, helper }) => (
      <div className="smAccountCount" key={key}>
        <dt>{t(locale, label)}</dt>
        <dd>
          <span className="smAccountCountValue">{counts[key].toLocaleString(locale)}</span>
          <span className="smAccountCountHelp">{t(locale, helper)}</span>
        </dd>
      </div>
    ))}
  </dl>
}
