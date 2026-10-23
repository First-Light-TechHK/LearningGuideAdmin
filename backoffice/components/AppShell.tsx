"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import type { ErrorCode } from "@/contracts/envelope";
import type { EmployeeRole } from "@/contracts/employee";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import {
  AiTutorIcon,
  BrandMark,
  CloseIcon,
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
} from "@/components/icons";
import type { Locale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";
import { useLocale } from "@/lib/i18n/useLocale";
import {
  menuFromPathSegments,
  menuHref,
  visibleMenus,
  type MenuKey,
} from "@/modules/rbac/permissions";

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
  children,
}: {
  employee: ShellEmployee;
  children: React.ReactNode;
}) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname() ?? `/${locale}/course`;
  const activeMenu = menuFromPathSegments(pathname.split("/").filter(Boolean).slice(1));
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const menus = visibleMenus(employee.role);
  const roleLabel = t(locale, `roles.${employee.role}`);

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    router.replace(`/${locale}/sign-in`);
    router.refresh();
  }

  return (
    <div className={collapsed ? "shell shellCollapsed" : "shell"}>
      <nav className="sidebar" aria-label={t(locale, "app.subtitle")}>
        <button
          type="button"
          className="sidebarToggle"
          aria-label={t(locale, collapsed ? "shell.expand" : "shell.collapse")}
          title={t(locale, collapsed ? "shell.expand" : "shell.collapse")}
          onClick={() => setCollapsed((value) => !value)}
        >
          <PanelToggleIcon size={18} />
        </button>

        {menus.map((menu) => {
          const Icon = MENU_ICON[menu];
          return (
            <a
              key={menu}
              className={menu === activeMenu ? "navItem navItemActive" : "navItem"}
              href={menuHref(locale, menu)}
              title={t(locale, MENU_LABEL[menu])}
            >
              <span className="navIcon">
                <Icon size={20} />
              </span>
              <span>{t(locale, MENU_LABEL[menu])}</span>
            </a>
          );
        })}
      </nav>

      <div className="main">
        <header className="header">
          {/* PORT-NAV-001：共享顶部栏展示 logo 与产品名 */}
          <span className="headerBrand">
            <BrandMark size={42} />
            {t(locale, "app.name")}
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

        <main className="content">{children}</main>
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
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword, locale }),
      });
      const payload = (await response.json()) as { success: boolean; error: ErrorCode | null };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      // PORT-PWD-006：改密后必须重新登录
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
      <form className="modal" onSubmit={submit} noValidate>
        <div className="modalHead">
          <div>
            <h2 className="modalTitle">{t(locale, "changePassword.title")}</h2>
            <p className="modalSubtitle">{t(locale, "changePassword.subtitle")}</p>
          </div>
          <button type="button" className="modalClose" onClick={onClose} aria-label={t(locale, "common.cancel")}>
            <CloseIcon size={16} />
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
