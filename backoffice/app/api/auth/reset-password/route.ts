import { NextResponse } from "next/server";

import { ok, type Envelope } from "@/contracts/envelope";
import { clientIp, jsonFail, readJson, readString } from "@/lib/http";
import { sessionCookieOptions } from "@/lib/sessionCookie";
import { resetWithToken } from "@/modules/user-authentication/services/passwordFlows";

/** PORT-PWD-002 / PORT-PWD-004：单次令牌设置新密码。 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  try {
    const outcome = await resetWithToken({
      rawToken: readString(body, "token"),
      password: readString(body, "password"),
      confirmPassword: readString(body, "confirmPassword"),
      ipAddress: clientIp(request),
      locale: readString(body, "locale") || "en-GB",
    });
    if (!outcome.ok) return jsonFail(outcome.code, "Reset rejected");

    const response = NextResponse.json<Envelope<{ reset: true }>>(ok({ reset: true }));
    // 重置后旧会话已全部吊销，顺便清掉本机 Cookie
    response.cookies.set({ ...sessionCookieOptions(0), value: "" });
    return response;
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to reset password");
  }
}
