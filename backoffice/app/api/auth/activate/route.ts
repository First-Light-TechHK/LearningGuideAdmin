import { clientIp, jsonFail, jsonOk, readJson, readString } from "@/lib/http";
import { consume } from "@/lib/rateLimit";
import { EMAIL_SEND_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES } from "@/lib/securityPolicy";
import { activateWithToken } from "@/modules/user-authentication/services/passwordFlows";

/** PORT-ACT-002 / PORT-ACT-003：用激活链接设置初始密码。 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  const ip = clientIp(request);
  const limit = consume(`activate:${ip}`, EMAIL_SEND_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES);
  if (!limit.allowed) return jsonFail("RATE_LIMITED", "Too many activation attempts");

  try {
    const outcome = await activateWithToken({
      rawToken: readString(body, "token"),
      password: readString(body, "password"),
      confirmPassword: readString(body, "confirmPassword"),
      ipAddress: ip,
      locale: readString(body, "locale") || "en-GB",
    });
    if (!outcome.ok) return jsonFail(outcome.code, "Activation rejected");
    return jsonOk({ activated: true });
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to activate account");
  }
}
