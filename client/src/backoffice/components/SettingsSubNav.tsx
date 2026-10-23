import { Link } from "react-router-dom";

import { usePathname } from "../lib/navigation";

import type { EmployeeRole } from "../contracts/employee";
import { t } from "../lib/i18n/messages";
import { useLocale } from "../lib/navigation";
import {
  settingsSubHref,
  visibleSettingsSubs,
  type SettingsSubKey,
} from "../rbac/permissions";

const SUB_LABEL: Record<SettingsSubKey, string> = {
  employeeAccount: "nav.employeeAccount",
  paymentGateway: "nav.paymentGateway",
  notificationConfiguration: "nav.notificationConfiguration",
};

/** 设计稿：Settings 的二级导航是内容区左侧一列，而不是侧边栏内的嵌套项。 */
export function SettingsSubNav({ role }: { role: EmployeeRole }) {
  const locale = useLocale();
  const pathname = usePathname() ?? "";

  return (
    <nav className="subNav" aria-label={t(locale, "nav.settings")}>
      {visibleSettingsSubs(role).map((sub) => {
        const href = settingsSubHref(locale, sub);
        return (
          <Link
            key={sub}
            className={pathname === href ? "subNavItem subNavItemActive" : "subNavItem"}
            to={href}
          >
            {t(locale, SUB_LABEL[sub])}
          </Link>
        );
      })}
    </nav>
  );
}
