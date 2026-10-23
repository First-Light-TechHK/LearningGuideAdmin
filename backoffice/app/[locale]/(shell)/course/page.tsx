import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";

export default async function CoursePage({
  params,
}: Readonly<{ params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  return (
    <section className="card cardGrow">
      <h1 className="cardTitle">{t(safeLocale, "course.title")}</h1>
      <p className="cardBody">{t(safeLocale, "course.description")}</p>
    </section>
  );
}
