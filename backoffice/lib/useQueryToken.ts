"use client";

import { useEffect, useState } from "react";

/**
 * 从地址栏读取一次性令牌。
 * 不用 useSearchParams 是为了避免静态预渲染时的 Suspense 要求，
 * 这些页面本身就是纯客户端流程，令牌只需在浏览器端可得。
 */
export function useQueryToken(): { token: string; ready: boolean } {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token") ?? "");
    setReady(true);
  }, []);

  return { token, ready };
}
