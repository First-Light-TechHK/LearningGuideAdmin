import { useEffect, useState } from "react";
import { useWorkspace } from "../../stores/workspaceSession";
import { Link, useLocation } from "react-router-dom";

import { usePathname, useRouter } from "../lib/navigation";

import type { ErrorCode } from "../contracts/envelope";
import type { EmployeeRole } from "../contracts/employee";
import { LocaleSwitch } from "./LocaleSwitch";
import {
  AiTutorIcon,
  BrandMark,
  CloseCircleIcon,
  CourseIcon,
  HelpDeskIcon,
  KeyIcon,
  KnowledgeIcon,
  OrderIcon,
  PanelToggleIcon,
  ReportingIcon,
  SettingsIcon,
  SignOutIcon,
  StudentIcon,
} from "./icons";
import type { Locale } from "../lib/i18n/config";
import { t } from "../lib/i18n/messages";
import { useLocale } from "../lib/navigation";
import {
  menuFromPathSegments,
  menuHref,
  type MenuKey,
} from "../rbac/permissions";
import { boFetch, postJson } from "../lib/api";
import { cachedEnvironmentIdentity, environmentName, type EnvironmentIdentity } from "../lib/environment";
import { clearEmployeeWorkspace } from "../lib/signOutCleanup";

const MENU_ICON: Record<MenuKey, (props: { size?: number }) => React.ReactElement> = {
  course: CourseIcon,
  knowledge: KnowledgeIcon,
  aiTutor: AiTutorIcon,
  order: OrderIcon,
  reporting: ReportingIcon,
  student: StudentIcon,
  helpDesk: HelpDeskIcon,
  settings: SettingsIcon,
};

const MENU_LABEL: Record<MenuKey, string> = {
  course: "nav.course",
  knowledge: "nav.knowledge",
  aiTutor: "nav.aiTutor",
  order: "nav.order",
  reporting: "nav.reporting",
  student: "nav.student",
  helpDesk: "nav.helpDesk",
  settings: "nav.settings",
};

export type ShellEmployee = {
  displayName: string;
  loginEmail: string;
  role: EmployeeRole;
};

export function AppShell({
  employee,
  menus,
  workspace = false,
  initialCollapsed = false,
  environment = cachedEnvironmentIdentity(),
  children,
}: {
  /** 环境身份（ShellRoute 从 /api/health 与环境端点解析）：决定墙与钥石 */
  environment?: EnvironmentIdentity;
  employee: ShellEmployee;
  /** 侧栏菜单：ShellRoute 已按“角色权限 ∩ 已启用能力”算好，顺序按 PRD PORT-NAV-002 */
  menus: readonly MenuKey[];
  /** Knowledge / AI Tutor 工作区占满内容区 */
  workspace?: boolean;
  /** PORT-NAV-003：登录后按账号偏好恢复折叠状态 */
  initialCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname() ?? `/${locale}/course`;
  const activeMenu = menuFromPathSegments(pathname.split("/").filter(Boolean).slice(1));
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const envName = environmentName(locale, environment);

  const session = useWorkspace();
  const { search } = useLocation();
  useEffect(() => {
    if (!activeMenu) return;
    const params = new URLSearchParams(search);
    const safe = new URLSearchParams();
    for (const key of ['tab', 'courseId', 'pageId', 'entryId', 'draftId', 'lessonId', 'versionId', 'student', 'candidate']) {
      if (params.has(key)) safe.set(key, params.get(key)!);
    }
    const relativePath = pathname.split('/').slice(2).join('/');
    session.write('menu.' + activeMenu, relativePath + (safe.size ? '?' + safe.toString() : ''));
    if (activeMenu === 'knowledge') session.write('knowledge.tab.' + (safe.get('tab') ?? 'pages'), safe.toString());
  }, [session, activeMenu, pathname, search]);
  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') session.flush() };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', session.flush);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', session.flush);
      session.flush();
    };
  }, [session]);
  const roleLabel = t(locale, `roles.${employee.role}`);

  /** PORT-NAV-003：折叠状态按账号落库，失败不阻断交互。 */
  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    void postJson("/api/preferences/sidebar", {
      state: next ? "collapsed" : "expanded",
    });
  }

  async function signOut() {
    await boFetch("/api/auth/sign-out", { method: "POST" });
    clearEmployeeWorkspace();
    router.replace(`/${locale}/sign-in`);
    router.refresh();
  }

  return (
    <div className={collapsed ? "shell shellCollapsed" : "shell"} data-env={environment.kind}>
      <div className="envWall">
        {/* 钥石在 DOM 最前：读屏先听到环境，再听到导航 */}
        <p className="envKeystone" data-testid="env-keystone" data-env-code={environment.code ?? ""} data-pending={environment.pending ? "true" : undefined}>
          <span className="envMark" aria-hidden="true" />
          <span aria-hidden="true">{envName}</span>
          {envName !== "" && <span className="visuallyHidden">{t(locale, "shell.environment.announce", { name: envName })}</span>}
        </p>
        <div className="appSurface">
      <header className="header">
        {/* PORT-NAV-001：共享顶部栏展示 logo 与产品名 */}
        <span className="headerBrand">
          <BrandMark size={34} />
          <span>
            <span>{t(locale, "shell.brandLead")}</span>{" "}
            <span className="brandTail">{t(locale, "shell.brandTail")}</span>
          </span>
        </span>

        <div className="headerRight">
          <LocaleSwitch persist />

          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="employeeTrigger"
              onClick={() => setMenuOpen((value) => !value)}
              aria-expanded={menuOpen}
              aria-label={t(locale, "shell.employeeMenu")}
            >
              <span className="avatar" aria-hidden="true">
                {employee.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="employeeMeta">
                <span className="employeeName">{employee.displayName}</span>
                <span className="employeeRole">{roleLabel}</span>
              </span>
            </button>

            {menuOpen ? (
              <div className="dropdown">
                {/* PORT-NAV-005：员工下拉只含 Change Password 与 Sign Out */}
                <button
                  type="button"
                  className="dropdownItem"
                  onClick={() => {
                    setMenuOpen(false);
                    setPasswordOpen(true);
                  }}
                >
                  <KeyIcon size={14} />
                  {t(locale, "shell.changePassword")}
                </button>
                <button
                  type="button"
                  className="dropdownItem dropdownItemDanger"
                  onClick={() => void signOut()}
                >
                  <SignOutIcon size={14} />
                  {t(locale, "shell.signOut")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="shellBody">
        <nav className="sidebar" aria-label={t(locale, "app.subtitle")}>
          <button
            type="button"
            className="sidebarToggle"
            aria-label={t(locale, collapsed ? "shell.expand" : "shell.collapse")}
            title={t(locale, collapsed ? "shell.expand" : "shell.collapse")}
            onClick={toggleSidebar}
          >
            <PanelToggleIcon size={24} />
          </button>

          {menus.map((menu) => {
            const Icon = MENU_ICON[menu];
            const saved = session.read<string>("menu." + menu);
            return (
              <Link
                key={menu}
                className={menu === activeMenu ? "navItem navItemActive" : "navItem"}
                to={saved && menu !== activeMenu ? `/${locale}/${saved}` : menuHref(locale, menu)}
                title={t(locale, MENU_LABEL[menu])}
                data-menu={menu}
              >
                <span className="navIcon">
                  <Icon size={20} />
                </span>
                <span>{t(locale, MENU_LABEL[menu])}</span>
              </Link>
            );
          })}
        </nav>

        <main className={workspace ? "content contentWorkspace" : "content"}>{children}</main>
      </div>
        </div>
      </div>

      {passwordOpen ? (
        <ChangePasswordDialog locale={locale} onClose={() => setPasswordOpen(false)} />
      ) : null}
    </div>
  );
}

function ChangePasswordDialog({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(null);

    if (newPassword !== confirmPassword) {
      setErrorCode("PASSWORD_MISMATCH");
      return;
    }

    setSubmitting(true);
    try {
      const result = await boFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword, locale }),
      });
      const payload = (await result.json()) as {
        success: boolean;
        error: ErrorCode | null;
      };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      router.replace(`/${locale}/sign-in`);
      router.refresh();
    } catch {
      setErrorCode("INTERNAL_ERROR");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="modal modalNarrow" onSubmit={submit} noValidate>
        <div className="modalHead">
          <div>
            <h2 className="modalTitle">{t(locale, "changePassword.title")}</h2>
            <p className="modalSubtitle">{t(locale, "changePassword.subtitle")}</p>
          </div>
          <button
            type="button"
            className="modalClose"
            onClick={onClose}
            aria-label={t(locale, "common.close")}
            title={t(locale, "common.close")}
          >
            <CloseCircleIcon size={16} />
          </button>
        </div>

        {errorCode ? (
          <div className="alert alertError" style={{ margin: "0 28px" }}>
            {t(locale, `errors.${errorCode}`)}
          </div>
        ) : null}

        <div className="modalBody">
          <label className="field">
            <span className="fieldLabel">{t(locale, "changePassword.currentLabel")}</span>
            <input
              className="fieldInput"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>

          <label className="field">
            <span className="fieldLabel">{t(locale, "changePassword.newLabel")}</span>
            <input
              className="fieldInput"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>

          <label className="field">
            <span className="fieldLabel">{t(locale, "changePassword.confirmLabel")}</span>
            <input
              className="fieldInput"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          </label>
        </div>

        <div className="modalFooter">
          <button type="button" className="button buttonGhost" onClick={onClose}>
            {t(locale, "common.cancel")}
          </button>
          <button type="submit" className="button" disabled={submitting}>
            {submitting ? t(locale, "changePassword.submitting") : t(locale, "changePassword.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
