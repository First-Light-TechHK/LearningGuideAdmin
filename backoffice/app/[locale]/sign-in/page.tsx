"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ErrorCode } from "@/contracts/envelope";
import { AuthLayout } from "@/components/AuthLayout";
import { CheckIcon, EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "@/components/icons";
import type { Locale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";
import { useLocale } from "@/lib/i18n/useLocale";

type EmailCheckState = "idle" | "checking" | "eligible" | "notEligible";

const EMAIL_CHECK_DELAY_MS = 500;

export default function SignInPage() {
  const locale = useLocale();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailState, setEmailState] = useState<EmailCheckState>("idle");
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // 不用 autoFocus：SSR 会输出 autofocus 属性，客户端补水时属性不一致会触发 React 警告
  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const runEmailCheck = useCallback(async (value: string) => {
    setEmailState("checking");
    try {
      const response = await fetch("/api/auth/email-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data: { eligible: boolean } | null;
      };
      setEmailState(payload.success && payload.data?.eligible ? "eligible" : "notEligible");
    } catch {
      setEmailState("idle");
    }
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (email.trim() === "") {
      setEmailState("idle");
      return;
    }
    timer.current = setTimeout(() => void runEmailCheck(email), EMAIL_CHECK_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [email, runEmailCheck]);

  /** PORT-LOG-002：提交前确认邮箱属于可用员工账号，再提交密码。 */
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(null);
    setSubmitting(true);

    try {
      const check = await fetch("/api/auth/email-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const checkPayload = (await check.json()) as {
        success: boolean;
        data: { eligible: boolean } | null;
        error: ErrorCode | null;
      };
      if (!checkPayload.success) {
        setErrorCode(checkPayload.error ?? "INTERNAL_ERROR");
        return;
      }
      if (!checkPayload.data?.eligible) {
        setEmailState("notEligible");
        setErrorCode("INVALID_EMPLOYEE_ACCOUNT");
        return;
      }
      setEmailState("eligible");

      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        error: ErrorCode | null;
        data: { locale: Locale } | null;
      };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      // PORT-NAV-006：账号偏好优先，服务端已把 Cookie 写成该语言
      const nextLocale = payload.data?.locale ?? locale;
      router.replace(`/${nextLocale}/course`);
      router.refresh();
    } catch {
      setErrorCode("INTERNAL_ERROR");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title={t(locale, "signIn.title")} subtitle={t(locale, "signIn.subtitle")}>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label className="fieldLabel" htmlFor="sign-in-email">
            {t(locale, "signIn.emailLabel")}
          </label>
          <div className="inputShell">
            <span className="inputShellIcon">
              <MailIcon size={15} />
            </span>
            <input
              id="sign-in-email"
              className="inputShellInput"
              type="email"
              name="email"
              autoComplete="username"
              ref={emailRef}
              placeholder={t(locale, "signIn.emailPlaceholder")}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setErrorCode(null);
              }}
              required
            />
            {emailState === "eligible" ? (
              <span className="validMark" title={t(locale, "signIn.validEmployee")}>
                <CheckIcon size={11} />
              </span>
            ) : null}
          </div>
        </div>

        <div className="field" style={{ marginBottom: 10 }}>
          <label className="fieldLabel" htmlFor="sign-in-password">
            {t(locale, "signIn.passwordLabel")}
          </label>
          <div className="inputShell">
            <span className="inputShellIcon">
              <LockIcon size={15} />
            </span>
            <input
              id="sign-in-password"
              className="inputShellInput"
              type={showPassword ? "text" : "password"}
              name="password"
              autoComplete="current-password"
              placeholder={t(locale, "signIn.passwordPlaceholder")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button
              type="button"
              className="iconButton"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={
                showPassword ? t(locale, "signIn.hidePassword") : t(locale, "signIn.showPassword")
              }
              title={
                showPassword ? t(locale, "signIn.hidePassword") : t(locale, "signIn.showPassword")
              }
            >
              {showPassword ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
            </button>
          </div>
        </div>

        <div className="authFormFootnote">
          <a className="linkButton" href={`/${locale}/forgot-password`}>
            {t(locale, "signIn.forgotPassword")}
          </a>
          {emailState === "notEligible" && !errorCode ? (
            <span className="fieldHint">{t(locale, "signIn.invalidEmployee")}</span>
          ) : null}
        </div>

        {errorCode ? <div className="alert alertError">{t(locale, `errors.${errorCode}`)}</div> : null}

        <button className="button buttonBlock" type="submit" disabled={submitting}>
          {submitting ? t(locale, "signIn.submitting") : t(locale, "signIn.submit")}
        </button>
      </form>
    </AuthLayout>
  );
}
