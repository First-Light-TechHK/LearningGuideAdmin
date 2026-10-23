import { notFound } from "next/navigation";

import { currentEmployee } from "@/lib/currentSession";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";
import { canViewMenu, menuFromPathSegments } from "@/modules/rbac/permissions";

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

  // PORT-NAV-004 / §15.3：直接输入 URL 也必须按权限拒绝
  if (!canViewMenu(employee.role, menu)) {
    return (
      <section className="card cardGrow">
        <h1 className="cardTitle">{t(safeLocale, "forbidden.title")}</h1>
        <p className="cardBody">{t(safeLocale, "forbidden.description")}</p>
        <p style={{ marginTop: 12 }}>
          <a className="button buttonGhost" href={`/${safeLocale}/course`}>
            {t(safeLocale, "forbidden.backToCourse")}
          </a>
        </p>
      </section>
    );
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
