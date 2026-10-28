import { useEffect, useState } from "react";

import type { ErrorCode } from "../contracts/envelope";
import { boRequest } from "./api";

type LinkStatus = "usable" | "expired" | "used" | "invalid";

const TERMINAL: Record<Exclude<LinkStatus, "usable">, ErrorCode> = {
  expired: "TOKEN_EXPIRED",
  used: "TOKEN_ALREADY_USED",
  invalid: "INVALID_TOKEN",
};

/**
 * PORT-ACT-003：打开激活 / 重置链接时先问服务端链接是否还能用，
 * 过期或已用直接显示专用提示，不让员工先填完密码才发现。
 * 查询失败（断网、限流）时不拦截，表单提交时服务端仍会再校验。
 */
export function useLinkStatus(
  token: string,
  ready: boolean,
  purpose: "activation" | "reset",
): { checking: boolean; terminal: ErrorCode | null } {
  const [checked, setChecked] = useState<{ token: string; terminal: ErrorCode | null } | null>(null);

  useEffect(() => {
    if (!ready || token === "") return;
    let cancelled = false;
    const query = new URLSearchParams({ token, purpose });
    void boRequest<{ status: LinkStatus }>(`/api/auth/token-status?${query.toString()}`).then((result) => {
      if (cancelled) return;
      const status = result.success ? result.data.status : "usable";
      setChecked({ token, terminal: status === "usable" ? null : TERMINAL[status] });
    });
    return () => {
      cancelled = true;
    };
  }, [token, ready, purpose]);

  if (!ready || token === "") return { checking: false, terminal: null };
  if (checked?.token !== token) return { checking: true, terminal: null };
  return { checking: false, terminal: checked.terminal };
}
