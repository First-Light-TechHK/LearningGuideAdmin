import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";

/**
 * PRD §7.3 / §8.5：权限被收紧后，服务端把员工送回 Course（允许的默认页），
 * 并展示「You no longer have permission to access this page.」提示。
 */
export default async function CoursePage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ denied?: string }>;
}>) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const { denied } = await searchParams;

  return (
    <section className="card cardGrow">
      {denied ? <div className="alert alertInfo">{t(safeLocale, "forbidden.description")}</div> : null}
      <h1 className="cardTitle">{t(safeLocale, "course.title")}</h1>
      <p className="cardBody">{t(safeLocale, "course.description")}</p>
    </section>
  );
}
