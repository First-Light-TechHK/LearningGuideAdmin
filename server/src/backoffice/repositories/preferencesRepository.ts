import { query } from '../lib/db';

/** PRD PORT-NAV-006：语言选择需在跨登录后保留，因此落库而非只在浏览器。 */
export async function findLocale(employeeId: string): Promise<string | null> {
  const rows = await query<{ locale: string }>(
    `SELECT locale FROM employee_ui_preferences WHERE employee_id = $1`,
    [employeeId],
  );
  return rows[0]?.locale ?? null;
}

export async function upsertLocale(
  employeeId: string,
  locale: string,
): Promise<void> {
  await query(
    `INSERT INTO employee_ui_preferences (employee_id, locale, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (employee_id)
     DO UPDATE SET locale = EXCLUDED.locale, updated_at = now()`,
    [employeeId, locale],
  );
}

export async function findSidebarState(
  employeeId: string,
): Promise<string | null> {
  const rows = await query<{ sidebar_state: string }>(
    `SELECT sidebar_state FROM employee_ui_preferences WHERE employee_id = $1`,
    [employeeId],
  );
  return rows[0]?.sidebar_state ?? null;
}

export async function upsertSidebarState(
  employeeId: string,
  state: string,
): Promise<void> {
  await query(
    `INSERT INTO employee_ui_preferences (employee_id, sidebar_state, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (employee_id)
     DO UPDATE SET sidebar_state = EXCLUDED.sidebar_state, updated_at = now()`,
    [employeeId, state],
  );
}
