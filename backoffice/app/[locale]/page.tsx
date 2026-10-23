import { redirect } from "next/navigation";

import { currentEmployee } from "@/lib/currentSession";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { DEFAULT_LANDING_MENU, menuHref } from "@/modules/rbac/permissions";

export default async function LocaleIndexPage({
  params,
}: Readonly<{ params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  const employee = await currentEmployee();
  if (!employee) redirect(`/${safeLocale}/sign-in`);

  redirect(menuHref(safeLocale, DEFAULT_LANDING_MENU));
}
