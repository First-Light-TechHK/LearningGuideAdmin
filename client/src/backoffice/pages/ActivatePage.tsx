import { useState } from "react";

import type { ErrorCode } from "../contracts/envelope";
import { AuthLayout } from "../components/AuthLayout";
import { t } from "../lib/i18n/messages";
import { useLocale } from "../lib/navigation";
import { useQueryToken } from "../lib/navigation";
import { boFetch } from "../lib/api";
import { useLinkStatus } from "../lib/linkStatus";

/** 这些状态说明链接已经不可用，不再显示表单（PORT-ACT-003）。 */
const TERMINAL_CODES: readonly ErrorCode[] = [
  "TOKEN_EXPIRED",
  "TOKEN_ALREADY_USED",
  "INVALID_TOKEN",
];

export default function ActivatePage() {
  const locale = useLocale();
  const { token, ready } = useQueryToken();
  const link = useLinkStatus(token, ready, "activation");

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
      const response = await boFetch("/api/auth/activate", {
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

  if (!ready || link.checking) {
    return (
      <AuthLayout title={t(locale, "activate.title")} subtitle={t(locale, "common.loading")}>
        <p className="modalHint">{t(locale, "common.loading")}</p>
      </AuthLayout>
    );
  }

  if (!token) {
    return (
      <AuthLayout
        title={t(locale, "activate.invalidTitle")}
        subtitle={t(locale, "activate.missingToken")}
        backHref={signInHref}
        backLabel={signInLabel}
      >
        <a className="button" href={signInHref} style={{ width: "100%" }}>
          {signInLabel}
        </a>
      </AuthLayout>
    );
  }

  const terminal = errorCode && TERMINAL_CODES.includes(errorCode) ? errorCode : link.terminal;
  if (terminal) {
    const expired = terminal === "TOKEN_EXPIRED";
    return (
      <AuthLayout
        title={t(locale, expired ? "activate.expiredTitle" : "activate.invalidTitle")}
        subtitle={t(locale, expired ? "activate.expiredBody" : "activate.invalidBody")}
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
        title={t(locale, "activate.successTitle")}
        subtitle={t(locale, "activate.successBody")}
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
      title={t(locale, "activate.title")}
      subtitle={t(locale, "activate.subtitle")}
      backHref={signInHref}
      backLabel={signInLabel}
    >
      <form onSubmit={handleSubmit} noValidate>
        {errorCode ? (
          <div className="alert alertError">{t(locale, `errors.${errorCode}`)}</div>
        ) : null}

        <div className="field" style={{ marginBottom: 14 }}>
          <span className="fieldLabel">{t(locale, "activate.passwordLabel")}</span>
          <input
            className="fieldInput"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <span className="fieldHint">{t(locale, "passwordRule.hint")}</span>
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <span className="fieldLabel">{t(locale, "activate.confirmLabel")}</span>
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
          {submitting ? t(locale, "activate.submitting") : t(locale, "activate.submit")}
        </button>
      </form>
    </AuthLayout>
  );
}
