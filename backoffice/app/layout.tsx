import type { Metadata } from "next";
import { headers } from "next/headers";

import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";

import "./globals.css";

export const metadata: Metadata = {
  title: "Learning Guide BackOffice",
  description: "Learning Guide BackOffice administration portal",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const headerList = await headers();
  const raw = headerList.get("x-locale") ?? undefined;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
