import { clientIp, jsonFail, jsonOk, readJson, readString } from "@/lib/http";
import { consume } from "@/lib/rateLimit";
import { EMAIL_SEND_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES } from "@/lib/securityPolicy";
import { requestPasswordReset } from "@/modules/user-authentication/services/passwordFlows";

/** PORT-PWD-001：对外返回一致结果，避免账号枚举。 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  const limit = consume(
    `forgot:${clientIp(request)}`,
    EMAIL_SEND_MAX_PER_WINDOW,
    RATE_LIMIT_WINDOW_MINUTES
  );
  if (!limit.allowed) return jsonFail("RATE_LIMITED", "Too many reset requests");

  try {
    await requestPasswordReset({
      rawEmail: readString(body, "email"),
      ipAddress: clientIp(request),
      locale: readString(body, "locale") || "en-GB",
    });
    return jsonOk({ requested: true });
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to process reset request");
  }
}
