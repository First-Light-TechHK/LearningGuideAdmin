import { SettingsSubNav } from "@/components/SettingsSubNav";
import { currentAdminEmployee } from "@/lib/currentSession";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";
import { EmployeeAccountClient } from "./EmployeeAccountClient";

export default async function EmployeeAccountPage({
  params,
}: Readonly<{ params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  // PORT-LST-001：仅 Admin，服务端判定
  const admin = await currentAdminEmployee();
  if (!admin) {
    return (
      <section className="card cardGrow">
        <h1 className="cardTitle">{t(safeLocale, "forbidden.title")}</h1>
        <p className="cardBody">{t(safeLocale, "forbidden.description")}</p>
      </section>
    );
  }

  return (
    <>
      <SettingsSubNav role={admin.role} />
      <EmployeeAccountClient locale={safeLocale} />
    </>
  );
}
