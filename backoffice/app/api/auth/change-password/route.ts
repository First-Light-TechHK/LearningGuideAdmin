import { NextResponse } from "next/server";

import { ok, type Envelope } from "@/contracts/envelope";
import { currentEmployee } from "@/lib/currentSession";
import { clientIp, jsonFail, readJson, readString } from "@/lib/http";
import { sessionCookieOptions } from "@/lib/sessionCookie";
import { changeOwnPassword } from "@/modules/user-authentication/services/passwordFlows";

/** PORT-PWD-005 / PORT-PWD-006：改密成功后强制重新登录。 */
export async function POST(request: Request): Promise<Response> {
  const employee = await currentEmployee();
  if (!employee) return jsonFail("INVALID_EMPLOYEE_ACCOUNT", "No active session");

  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  try {
    const outcome = await changeOwnPassword({
      employee,
      currentPassword: readString(body, "currentPassword"),
      newPassword: readString(body, "newPassword"),
      confirmPassword: readString(body, "confirmPassword"),
      ipAddress: clientIp(request),
      locale: readString(body, "locale") || "en-GB",
    });
    if (!outcome.ok) return jsonFail(outcome.code, "Change rejected");

    const response = NextResponse.json<Envelope<{ changed: true }>>(ok({ changed: true }));
    response.cookies.set({ ...sessionCookieOptions(0), value: "" });
    return response;
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to change password");
  }
}
