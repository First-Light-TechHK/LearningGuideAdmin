import { currentEmployee } from "@/lib/currentSession";
import { jsonFail, jsonOk, readJson, readString } from "@/lib/http";
import * as preferencesRepository from "@/repositories/preferencesRepository";

const STATES = ["expanded", "collapsed"] as const;

/** PORT-NAV-003：折叠状态按账号保留，跨页面与再次登录不丢失。 */
export async function POST(request: Request): Promise<Response> {
  const employee = await currentEmployee();
  if (!employee) return jsonFail("INVALID_EMPLOYEE_ACCOUNT", "No active session");

  const body = await readJson(request);
  if (!body) return jsonFail("INVALID_INPUT", "Malformed request body");

  const state = readString(body, "state");
  if (!(STATES as readonly string[]).includes(state)) {
    return jsonFail("INVALID_INPUT", "Unsupported sidebar state");
  }

  try {
    await preferencesRepository.upsertSidebarState(employee.employeeId, state);
  } catch {
    return jsonFail("INTERNAL_ERROR", "Unable to save sidebar state");
  }

  return jsonOk({ state });
}
