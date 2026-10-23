"use client";

import { useState } from "react";

import type { ErrorCode } from "@/contracts/envelope";
import { AuthLayout } from "@/components/AuthLayout";
import { t } from "@/lib/i18n/messages";
import { useLocale } from "@/lib/i18n/useLocale";
import { useQueryToken } from "@/lib/useQueryToken";

const TERMINAL_CODES: readonly ErrorCode[] = [
  "TOKEN_EXPIRED",
  "TOKEN_ALREADY_USED",
  "INVALID_TOKEN",
];

export default function ResetPasswordPage() {
  const locale = useLocale();
  const { token, ready } = useQueryToken();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(null);

    if (password !== confirmPassword) {
      setErrorCode("PASSWORD_MISMATCH");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password, confirmPassword, locale }),
      });
      const payload = (await response.json()) as { success: boolean; error: ErrorCode | null };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      setDone(true);
    } catch {
      setErrorCode("INTERNAL_ERROR");
    } finally {
      setSubmitting(false);
    }
  }

  const signInHref = `/${locale}/sign-in`;
  const signInLabel = t(locale, "activate.goSignIn");

  const terminal =
    errorCode !== null && TERMINAL_CODES.includes(errorCode)
      ? errorCode
      : !ready
        ? "LOADING"
        : token === ""
          ? "INVALID_TOKEN"
          : null;

  if (terminal === "LOADING") {
    return (
      <AuthLayout title={t(locale, "reset.title")} subtitle={t(locale, "common.loading")}>
        <p className="modalHint">{t(locale, "common.loading")}</p>
      </AuthLayout>
    );
  }

  if (terminal !== null) {
    const titleKey =
      terminal === "TOKEN_EXPIRED"
        ? "reset.expiredTitle"
        : terminal === "TOKEN_ALREADY_USED"
          ? "reset.usedTitle"
          : "reset.invalidTitle";
    const bodyKey =
      terminal === "TOKEN_EXPIRED"
        ? "reset.expiredBody"
        : terminal === "TOKEN_ALREADY_USED"
          ? "reset.usedBody"
          : "reset.invalidBody";

    return (
      <AuthLayout
        title={t(locale, titleKey)}
        subtitle={t(locale, bodyKey)}
        backHref={signInHref}
        backLabel={signInLabel}
      >
        <a className="button" href={signInHref} style={{ width: "100%" }}>
          {signInLabel}
        </a>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        title={t(locale, "reset.successTitle")}
        subtitle={t(locale, "reset.successBody")}
        backHref={signInHref}
        backLabel={signInLabel}
      >
        <a className="button" href={signInHref} style={{ width: "100%" }}>
          {signInLabel}
        </a>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t(locale, "reset.title")}
      subtitle={t(locale, "reset.subtitle")}
      backHref={signInHref}
      backLabel={signInLabel}
    >
      <form onSubmit={handleSubmit} noValidate>
        {errorCode ? (
          <div className="alert alertError">{t(locale, `errors.${errorCode}`)}</div>
        ) : null}

        <div className="field" style={{ marginBottom: 14 }}>
          <span className="fieldLabel">{t(locale, "reset.passwordLabel")}</span>
          <input
            className="fieldInput"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <span className="fieldLabel">{t(locale, "reset.confirmLabel")}</span>
          <input
            className="fieldInput"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
        </div>

        <button className="button" type="submit" disabled={submitting} style={{ width: "100%" }}>
          {submitting ? t(locale, "reset.submitting") : t(locale, "reset.submit")}
        </button>
      </form>
    </AuthLayout>
  );
}
