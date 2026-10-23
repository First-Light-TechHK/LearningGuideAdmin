import { currentAdminEmployee } from "@/lib/currentSession";
import { clientIp, jsonFail, jsonOk, readJson, readString } from "@/lib/http";
import { consume } from "@/lib/rateLimit";
import { EMAIL_SEND_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES } from "@/lib/securityPolicy";
import { reissueActivation } from "@/modules/user-authentication/services/passwordFlows";

type Context = { params: Promise<{ employeeId: string }> };

/** PORT-ACT-004：重发激活邮件，旧链接立即失效（仅 Admin）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const admin = await currentAdminEmployee();
  if (!admin) return jsonFail("NOT_AUTHORISED", "Admin only");

  const { employeeId } = await context.params;
  const body = (await readJson(request)) ?? {};

  const limit = consume(
    `resend-activation:${clientIp(request)}`,
    EMAIL_SEND_MAX_PER_WINDOW,
    RATE_LIMIT_WINDOW_MINUTES
  );
  if (!limit.allowed) return jsonFail("RATE_LIMITED", "Too many activation emails");

  try {
    const outcome = await reissueActivation({
      employeeId,
      actorEmployeeId: admin.employeeId,
      locale: readString(body, "locale") || "en-GB",
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) return jsonFail(outcome.code, "Resend rejected");
    return jsonOk({ delivery: outcome.delivery });
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to resend activation");
  }
}
