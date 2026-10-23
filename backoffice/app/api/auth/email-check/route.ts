import { clientIp, jsonFail, jsonOk, readJson, readString } from "@/lib/http";
import { EMAIL_CHECK_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES } from "@/lib/securityPolicy";
import { consume } from "@/lib/rateLimit";
import { checkEmployeeEmail } from "@/modules/user-authentication/services/signIn";

/** PORT-LOG-002 / PORT-LOG-003：Email Check。 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  const limit = consume(
    `email-check:${clientIp(request)}`,
    EMAIL_CHECK_MAX_PER_WINDOW,
    RATE_LIMIT_WINDOW_MINUTES
  );
  if (!limit.allowed) return jsonFail("RATE_LIMITED", "Too many email checks");

  try {
    return jsonOk(await checkEmployeeEmail(readString(body, "email")));
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to check employee email");
  }
}
