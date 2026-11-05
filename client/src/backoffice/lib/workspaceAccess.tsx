import { useMemo } from "react";
import { useEmployee } from '../employeeSession';
import { type MenuKey } from "../rbac/permissions";
import { buildAccess, WorkspaceAccessContext } from './workspaceAccessState';



export function WorkspaceAccessProvider({
  menu,
  children,
}: {
  menu: MenuKey;
  children: React.ReactNode;
}) {
  const employee = useEmployee();
  const access = useMemo(
    () => buildAccess(employee.role, menu),
    [employee.role, menu],
  );
  return (
    <WorkspaceAccessContext.Provider value={access}>
      {children}
    </WorkspaceAccessContext.Provider>
  );
}