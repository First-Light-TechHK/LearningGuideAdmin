import type { StudentList } from '../contracts/students'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/** Global account totals supplied by the student list API, independent of filters. */
export function StudentAccountCounts({ locale, counts }: { locale: Locale; counts: StudentList['counts'] }) {
  return <dl className="smAccountCounts" data-testid="student-account-counts">
    <div><dt>{t(locale, 'students.countTotal')}</dt><dd>{counts.total.toLocaleString(locale)}</dd></div>
    <div><dt>{t(locale, 'students.countActive')}</dt><dd>{counts.active.toLocaleString(locale)}</dd></div>
    <div><dt>{t(locale, 'students.countInactive')}</dt><dd>{counts.inactive.toLocaleString(locale)}</dd></div>
  </dl>
}
