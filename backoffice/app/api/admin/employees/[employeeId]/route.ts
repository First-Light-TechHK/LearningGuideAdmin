import { clientIp, jsonFail, jsonOk, readJson, readString } from "@/lib/http";
import { updateEmployee } from "@/modules/employee-account/services/employeeAccount";
import { requireAdmin } from "@/modules/rbac/adminGuard";

type Context = { params: Promise<{ employeeId: string }> };

/** PORT-EDT-001~006：编辑员工（仅 Admin）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const { employeeId } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  try {
    const outcome = await updateEmployee({
      employeeId,
      rawEmail: typeof body.email === "string" ? body.email : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
      accountStatus: typeof body.accountStatus === "string" ? body.accountStatus : undefined,
      actorEmployeeId: guard.admin.employeeId,
      locale: readString(body, "locale") || "en-GB",
      ipAddress: clientIp(request),
    });
    if (!outcome.ok) return jsonFail(outcome.code, "Update rejected");
    return jsonOk({ employee: outcome.employee, delivery: outcome.delivery ?? null });
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to update employee");
  }
}
