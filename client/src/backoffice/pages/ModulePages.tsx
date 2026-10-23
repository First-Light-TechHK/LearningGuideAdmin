import { Link, Navigate } from 'react-router-dom'

import { SettingsSubNav } from '../components/SettingsSubNav'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import {
  canAccessEmployeeAccount,
  canViewMenu,
  menuHref,
  settingsSubHref,
  visibleSettingsSubs,
  DEFAULT_LANDING_MENU,
  type MenuKey,
} from '../rbac/permissions'
import { useEmployee } from '../ShellRoute'
import { EmployeeAccountClient } from './EmployeeAccountPage'

const MENU_LABEL: Record<MenuKey, string> = {
  course: 'nav.course',
  knowledge: 'nav.knowledge',
  aiTutor: 'nav.aiTutor',
  order: 'nav.order',
  reporting: 'nav.reporting',
  student: 'nav.student',
  helpDesk: 'nav.helpDesk',
  settings: 'nav.settings',
}

export function ForbiddenCard() {
  const locale = useLocale()
  return (
    <section className="card cardGrow">
      <h1 className="cardTitle">{t(locale, 'forbidden.title')}</h1>
      <p className="cardBody">{t(locale, 'forbidden.description')}</p>
      <p style={{ marginTop: 12 }}>
        <Link className="button buttonGhost" to={menuHref(locale, DEFAULT_LANDING_MENU)}>
          {t(locale, 'forbidden.backToCourse')}
        </Link>
      </p>
    </section>
  )
}

/** PORT-NAV-004 / §15.3：直接输入 URL 也必须按权限拒绝（接口另由服务端守卫拒绝）。 */
export function MenuGuard({ menu, children }: { menu: MenuKey; children: React.ReactNode }) {
  const employee = useEmployee()
  return canViewMenu(employee.role, menu) ? <>{children}</> : <ForbiddenCard />
}

export function CoursePage() {
  const locale = useLocale()
  return (
    <section className="card cardGrow">
      <h1 className="cardTitle">{t(locale, 'course.title')}</h1>
      <p className="cardBody">{t(locale, 'course.description')}</p>
    </section>
  )
}

export function PlaceholderPage({ menu }: { menu: MenuKey }) {
  const locale = useLocale()
  return (
    <MenuGuard menu={menu}>
      <section className="card cardGrow">
        <h1 className="cardTitle">{t(locale, 'placeholder.title', { menu: t(locale, MENU_LABEL[menu]) })}</h1>
        <p className="cardBody">{t(locale, 'placeholder.description')}</p>
      </section>
    </MenuGuard>
  )
}

/** /settings 本身没有内容，落到当前角色第一个可见子项。 */
export function SettingsIndexPage() {
  const locale = useLocale()
  const employee = useEmployee()
  const [first] = visibleSettingsSubs(employee.role)
  return <Navigate to={first ? settingsSubHref(locale, first) : menuHref(locale, DEFAULT_LANDING_MENU)} replace />
}

export function EmployeeAccountSettingsPage() {
  const locale = useLocale()
  const employee = useEmployee()
  // PORT-LST-001：仅 Admin
  if (!canAccessEmployeeAccount(employee.role)) return <ForbiddenCard />
  return (
    <>
      <SettingsSubNav role={employee.role} />
      <EmployeeAccountClient locale={locale} />
    </>
  )
}

export function SettingsEntryPage({ section }: { section: 'paymentGateway' | 'notificationConfiguration' }) {
  const locale = useLocale()
  const employee = useEmployee()
  return (
    <MenuGuard menu="settings">
      <SettingsSubNav role={employee.role} />
      <section className="card cardGrow">
        <h1 className="cardTitle">{t(locale, `settings.${section}Title`)}</h1>
        <p className="cardSubtitle">{t(locale, `settings.${section}Body`)}</p>
      </section>
    </MenuGuard>
  )
}
