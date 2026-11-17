/**
 * 操作人姓名（PRD L703 "操作人姓名"、L727 "[Name]"）。`Employee` 没有姓名字段，
 * 暂用登录邮箱 @ 之前的部分；以后有显示名只改这一个文件。
 * 没有操作人（系统写入）显示 "System"。
 */
export const SYSTEM_OPERATOR = 'System';

/** 只要求有 `employee.findMany`，所以 PrismaService、事务客户端和测试替身都能传进来。 */
export interface EmployeeNameDb {
  employee: {
    findMany(args: {
      where: { employeeId: { in: string[] } };
      select: { employeeId: true; loginEmail: true };
    }): PromiseLike<Array<{ employeeId: string; loginEmail: string }>>;
  };
}

export function nameFromEmail(loginEmail: string): string {
  return loginEmail.split('@')[0] || loginEmail;
}

/** 一次查询取回若干 employeeId 的显示名；重复与空 id 先去掉，没有 id 就不查。 */
export async function employeeNames(
  db: EmployeeNameDb,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (wanted.length === 0) return names;
  const rows = await db.employee.findMany({
    where: { employeeId: { in: wanted } },
    select: { employeeId: true, loginEmail: true },
  });
  for (const row of rows) {
    names.set(row.employeeId, nameFromEmail(row.loginEmail));
  }
  return names;
}

/** 空 id 读作 System；查不到的 id（员工已删除）原样返回，不丢信息。 */
export function operatorName(
  names: ReadonlyMap<string, string>,
  id: string | null | undefined,
): string {
  if (!id) return SYSTEM_OPERATOR;
  return names.get(id) ?? id;
}
