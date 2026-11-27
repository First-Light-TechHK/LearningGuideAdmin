import { Link, Navigate } from 'react-router-dom'

import { SettingsSubNav } from '../components/SettingsSubNav'
import { cachedAccountFeatures, cachedCapabilities, cachedSandboxResetEnabled, menuEffectiveLevel } from '../lib/capabilities'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import {
  canAccessEmployeeAccount,
  menuHref,
  settingsSubHref,
  visibleSettingsSubs,
  DEFAULT_LANDING_MENU,
  type MenuKey,
} from '../rbac/permissions'
import { useEmployee } from '../employeeSession';
import { EmployeeAccountClient } from './EmployeeAccountPage'
import { NotificationConfigurationPage } from './notification/NotificationConfigurationPage'

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

/** PORT-NAV-004 / §15.3：直接输入 URL 也必须按权限拒绝（接口另由服务端守卫拒绝）。
 *  账号功能键允许时可以把角色 NONE 的模块抬到 VIEW（与 /api/session 的 effective 一致）。 */
export function MenuGuard({ menu, children }: { menu: MenuKey; children: React.ReactNode }) {
  const employee = useEmployee()
  return menuEffectiveLevel(employee.role, menu) !== 'NONE' ? <>{children}</> : <ForbiddenCard />
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

/** /settings 本身没有内容，落到当前角色第一个可见子项（角色 ∩ 环境能力 ∩ 账号功能）。 */
export function SettingsIndexPage() {
  const locale = useLocale()
  const employee = useEmployee()
  const [first] = visibleSettingsSubs(
    employee.role,
    cachedCapabilities(),
    cachedAccountFeatures(),
    cachedSandboxResetEnabled(),
  )
  return <Navigate to={first ? settingsSubHref(locale, first) : menuHref(locale, DEFAULT_LANDING_MENU)} replace />
}

export function EmployeeAccountSettingsPage() {
  const locale = useLocale()
  const employee = useEmployee()
  // PORT-LST-001：仅 Admin；账号管理还要环境能力（settings 或 accounts）与 module.accounts 生效
  if (!canAccessEmployeeAccount(employee.role)) return <ForbiddenCard />
  const capabilities = cachedCapabilities()
  const accountFeatures = cachedAccountFeatures()
  const capabilityOpen = capabilities.has('settings') || capabilities.has('accounts')
  const featureOpen = accountFeatures === null || accountFeatures.has('module.accounts')
  if (!capabilityOpen || !featureOpen) return <ForbiddenCard />
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
  if (section === 'notificationConfiguration') return <NotificationConfigurationPage />
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
