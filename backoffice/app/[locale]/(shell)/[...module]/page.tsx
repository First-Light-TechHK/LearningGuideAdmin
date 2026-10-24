import { notFound, redirect } from "next/navigation";

import { currentEmployee } from "@/lib/currentSession";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";
import {
  canViewMenu,
  DEFAULT_LANDING_MENU,
  menuFromPathSegments,
  menuHref,
} from "@/modules/rbac/permissions";

const MENU_LABEL: Record<string, string> = {
  course: "nav.course",
  knowledge: "nav.knowledge",
  aiTutor: "nav.aiTutor",
  order: "nav.order",
  reporting: "nav.reporting",
  student: "nav.student",
  helpDesk: "nav.helpDesk",
  settings: "nav.settings",
};

export default async function ModulePlaceholderPage({
  params,
}: Readonly<{ params: Promise<{ locale: string; module: string[] }> }>) {
  const { locale, module } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  const menu = menuFromPathSegments(module);
  if (!menu) notFound();

  const employee = await currentEmployee();
  if (!employee) notFound();

  // §7.3 / §8.5：权限被收紧后直接输入 URL 也被拒绝，并送回 Course
  if (!canViewMenu(employee.role, menu)) {
    redirect(`${menuHref(safeLocale, DEFAULT_LANDING_MENU)}?denied=${menu}`);
  }

  return (
    <section className="card cardGrow">
      <h1 className="cardTitle">
        {t(safeLocale, "placeholder.title", { menu: t(safeLocale, MENU_LABEL[menu] ?? menu) })}
      </h1>
      <p className="cardBody">{t(safeLocale, "placeholder.description")}</p>
    </section>
  );
}
