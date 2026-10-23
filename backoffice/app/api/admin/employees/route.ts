import { currentAdminEmployee } from "@/lib/currentSession";
import { clientIp, jsonFail, jsonOk, readJson, readNumber, readString } from "@/lib/http";
import { consume } from "@/lib/rateLimit";
import { EMAIL_SEND_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES } from "@/lib/securityPolicy";
import {
  createEmployee,
  listEmployees,
} from "@/modules/employee-account/services/employeeAccount";

/** PORT-LST-001~005：员工列表（仅 Admin）。 */
export async function GET(request: Request): Promise<Response> {
  const admin = await currentAdminEmployee();
  if (!admin) return jsonFail("NOT_AUTHORISED", "Admin only");

  try {
    const params = new URL(request.url).searchParams;
    const result = await listEmployees({
      email: params.get("email") ?? undefined,
      role: params.get("role") ?? undefined,
      status: params.get("status") ?? undefined,
      page: readNumber({ page: params.get("page") ?? undefined }, "page", 1),
      pageSize: readNumber({ pageSize: params.get("pageSize") ?? undefined }, "pageSize", 10),
    });
    return jsonOk(result);
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to list employees");
  }
}

/** PORT-NEW-001~004：新建员工并发送激活邮件（仅 Admin）。 */
export async function POST(request: Request): Promise<Response> {
  const admin = await currentAdminEmployee();
  if (!admin) return jsonFail("NOT_AUTHORISED", "Admin only");

  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  const limit = consume(
    `employee-create:${clientIp(request)}`,
    EMAIL_SEND_MAX_PER_WINDOW,
    RATE_LIMIT_WINDOW_MINUTES
  );
  if (!limit.allowed) return jsonFail("RATE_LIMITED", "Too many creations");

  try {
    const outcome = await createEmployee({
      rawEmail: readString(body, "email"),
      role: readString(body, "role"),
      accountStatus: readString(body, "accountStatus"),
      actorEmployeeId: admin.employeeId,
      locale: readString(body, "locale") || "en-GB",
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) return jsonFail(outcome.code, "Create rejected");
    return jsonOk({ employee: outcome.employee, delivery: outcome.delivery });
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to create employee");
  }
}
