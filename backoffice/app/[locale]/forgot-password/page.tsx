"use client";

import { useState } from "react";

import type { ErrorCode } from "@/contracts/envelope";
import { AuthLayout } from "@/components/AuthLayout";
import { t } from "@/lib/i18n/messages";
import { useLocale } from "@/lib/i18n/useLocale";

export default function ForgotPasswordPage() {
  const locale = useLocale();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, locale }),
      });
      const payload = (await response.json()) as { success: boolean; error: ErrorCode | null };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      setSent(true);
    } catch {
      setErrorCode("INTERNAL_ERROR");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title={t(locale, "forgot.title")}
      subtitle={t(locale, "forgot.subtitle")}
      backHref={`/${locale}/sign-in`}
      backLabel={t(locale, "common.back")}
    >
      <form onSubmit={handleSubmit} noValidate>
        {sent ? <div className="alert alertOk">{t(locale, "forgot.sent")}</div> : null}
        {errorCode ? (
          <div className="alert alertError">{t(locale, `errors.${errorCode}`)}</div>
        ) : null}

        <div className="field" style={{ marginBottom: 14 }}>
          <span className="fieldLabel">{t(locale, "signIn.emailLabel")}</span>
          <input
            className="fieldInput"
            type="email"
            autoComplete="username"
            placeholder={t(locale, "signIn.emailPlaceholder")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <button className="button" type="submit" disabled={submitting} style={{ width: "100%" }}>
          {submitting ? t(locale, "forgot.submitting") : t(locale, "forgot.submit")}
        </button>
      </form>
    </AuthLayout>
  );
}
