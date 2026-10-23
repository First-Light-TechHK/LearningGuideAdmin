import { redirect } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { currentEmployee } from "@/lib/currentSession";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";

export default async function ShellLayout({
  children,
  params,
}: Readonly<{ children: React.ReactNode; params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  const employee = await currentEmployee();
  if (!employee) redirect(`/${safeLocale}/sign-in`);

  return (
    <AppShell
      employee={{
        displayName: employee.displayName,
        loginEmail: employee.loginEmail,
        role: employee.role,
      }}
    >
      {children}
    </AppShell>
  );
}
