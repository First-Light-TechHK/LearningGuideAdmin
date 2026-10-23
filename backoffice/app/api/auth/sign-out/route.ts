import { NextResponse } from "next/server";

import { ok, type Envelope } from "@/contracts/envelope";
import { currentSessionToken } from "@/lib/currentSession";
import { sessionCookieOptions } from "@/lib/sessionCookie";
import { destroySession } from "@/modules/user-authentication/services/session";

/** PORT-SES-002：无二次确认，立即吊销会话。 */
export async function POST(): Promise<Response> {
  try {
    await destroySession(await currentSessionToken());
  } catch {
    // 吊销失败也清除 Cookie：绝不让客户端保留一个可用令牌
  }

  const response = NextResponse.json<Envelope<{ signedOut: true }>>(ok({ signedOut: true }));
  response.cookies.set({ ...sessionCookieOptions(0), value: "" });
  return response;
}
