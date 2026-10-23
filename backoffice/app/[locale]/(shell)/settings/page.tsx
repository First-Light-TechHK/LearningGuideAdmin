import { redirect } from "next/navigation";

import { currentEmployee } from "@/lib/currentSession";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { settingsSubHref, visibleSettingsSubs } from "@/modules/rbac/permissions";

/** /settings 本身没有内容，落到当前角色第一个可见子项。 */
export default async function SettingsIndexPage({
  params,
}: Readonly<{ params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  const employee = await currentEmployee();
  if (!employee) redirect(`/${safeLocale}/sign-in`);

  const [first] = visibleSettingsSubs(employee.role);
  redirect(first ? settingsSubHref(safeLocale, first) : `/${safeLocale}/course`);
}
