"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { ChevronDownIcon } from "@/components/icons";
import { localeHref, otherLocale } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/useLocale";

/** 设计稿顶栏语言控件：当前语言短名 + 下拉箭头，点击切到另一种语言。 */
const SHORT_LABEL = { "en-GB": "EN", "zh-CN": "中文" } as const;

export function LocaleSwitch({
  persist,
  className = "localeButton",
}: {
  persist: boolean;
  className?: string;
}) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const target = otherLocale(locale);
  const [busy, setBusy] = useState(false);

  async function change() {
    if (busy) return;
    setBusy(true);
    try {
      const href = localeHref(pathname ?? `/${locale}/course`, target);
      if (persist) {
        try {
          await fetch("/api/preferences/locale", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ locale: target }),
          });
        } catch {
          // 偏好落库失败不阻断切换：URL 与 Cookie 仍会更新
        }
      }
      router.push(href);
    } finally {
      // 切换语言只改 :locale 参数，组件不会重新挂载；
      // 必须手动复位，否则 busy 会一直是 true，按钮再也点不动。
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => void change()}
      disabled={busy}
      aria-label={`Switch language to ${target}`}
      title={`Switch language to ${target}`}
    >
      {SHORT_LABEL[locale]}
      <ChevronDownIcon size={14} />
    </button>
  );
}
