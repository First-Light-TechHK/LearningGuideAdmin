import { LocaleSwitch } from "./LocaleSwitch";
import { DiamondIcon, GraduationCapIcon } from "./icons";
import { getMessages, t } from "../lib/i18n/messages";
import { useLocale } from "../lib/navigation";

/**
 * 认证页外壳，按设计稿：64px 白色品牌条 + 背景图 + 居中 logo 行 / 标题 / 副标题 + 白卡。
 * 设计稿 771:551 的 Above Card Content 是 424 宽竖排（gap 10），标题与副标题 textAlign=CENTER。
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  backHref,
  backLabel,
  showLegal = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  showLegal?: boolean;
}) {
  const locale = useLocale();
  const messages = getMessages(locale);

  return (
    <div className="authPage">
      <div className="authPageHeader">
        <span className="authBrand">
          <DiamondIcon size={22} />
          {messages.app.name}
        </span>
        <LocaleSwitch persist={false} />
      </div>

      <main className="authBody">
        <div className="authIntro">
          <span className="authBadge">
            <GraduationCapIcon size={22} />
            {messages.app.name}
          </span>
          <h1 className="authTitle">{title}</h1>
          {subtitle ? <p className="authSubtitle">{subtitle}</p> : null}
        </div>

        <div className="authCard">{children}</div>

        {backHref && backLabel ? (
          <a className="authFooterLink" href={backHref}>
            {backLabel}
          </a>
        ) : null}

        {showLegal ? (
          <p className="authLegal">
            {t(locale, "auth.legalPrefix")}{" "}
            <a
              href={`https://www.ilovelearningguide.com/${locale}/terms-of-service`}
              target="_blank"
              rel="noreferrer"
            >
              {t(locale, "auth.terms")}
            </a>{" "}
            &amp;{" "}
            <a
              href={`https://www.ilovelearningguide.com/${locale}/privacy-policy`}
              target="_blank"
              rel="noreferrer"
            >
              {t(locale, "auth.privacy")}
            </a>
          </p>
        ) : null}
      </main>
    </div>
  );
}
