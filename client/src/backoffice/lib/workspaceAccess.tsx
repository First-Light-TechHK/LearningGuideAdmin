import { useMemo } from "react";
import { useEmployee } from '../employeeSession';
import { type MenuKey } from "../rbac/permissions";
import { cachedAccountFeatures } from './capabilities';
import { buildAccess, WorkspaceAccessContext } from './workspaceAccessState';



export function WorkspaceAccessProvider({
  menu,
  children,
}: {
  menu: MenuKey;
  children: React.ReactNode;
}) {
  const employee = useEmployee();
  const features = cachedAccountFeatures();
  const access = useMemo(
    () => buildAccess(employee.role, menu, features),
    [employee.role, menu, features],
  );
  return (
    <WorkspaceAccessContext.Provider value={access}>
      {children}
    </WorkspaceAccessContext.Provider>
  );
}