import { Link } from "react-router-dom";

import { usePathname } from "../lib/navigation";

import type { EmployeeRole } from "../contracts/employee";
import { cachedAccountFeatures, cachedCapabilities } from "../lib/capabilities";
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
  learningAccess: "nav.learningAccess",
};

/**
 * 设计稿：Settings 的二级导航是内容区左侧一列，而不是侧边栏内的嵌套项。
 * 子项 = 角色 ∩ 环境能力 ∩ 账号功能键（缓存由 ShellRoute 在挂载外壳前写入）：
 * employeeAccount 只认 module.accounts；其它子项仍要 module.settings。
 */
export function SettingsSubNav({ role }: { role: EmployeeRole }) {
  const locale = useLocale();
  const pathname = usePathname() ?? "";

  return (
    <nav className="subNav" aria-label={t(locale, "nav.settings")}>
      {visibleSettingsSubs(role, cachedCapabilities(), cachedAccountFeatures()).map((sub) => {
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
