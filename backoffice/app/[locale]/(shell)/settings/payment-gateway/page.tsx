import { SettingsSubNav } from "@/components/SettingsSubNav";
import { currentEmployee } from "@/lib/currentSession";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";
import { canViewMenu } from "@/modules/rbac/permissions";

export default async function PaymentGatewayPage({
  params,
}: Readonly<{ params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  const employee = await currentEmployee();
  if (!employee || !canViewMenu(employee.role, "settings")) {
    return (
      <section className="card cardGrow">
        <h1 className="cardTitle">{t(safeLocale, "forbidden.title")}</h1>
        <p className="cardBody">{t(safeLocale, "forbidden.description")}</p>
      </section>
    );
  }

  return (
    <>
      <SettingsSubNav role={employee.role} />
      <section className="card cardGrow">
        <h1 className="cardTitle">{t(safeLocale, "settings.paymentGatewayTitle")}</h1>
        <p className="cardSubtitle">{t(safeLocale, "settings.paymentGatewayBody")}</p>
      </section>
    </>
  );
}
