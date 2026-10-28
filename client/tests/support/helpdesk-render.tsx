/* oxlint-disable react/only-export-components -- 测试辅助文件，不走 Fast Refresh */
// HelpDesk 页面的渲染外壳：与 App.tsx 同一条路由（/:locale → ShellRoute → help-desk/:ticketId?），
// 角色来自假的 /api/session，所以 VIEW / FULL 走的是真实的 RBAC 与 WorkspaceAccessProvider。
import { render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { App as AntApp, ConfigProvider } from 'antd'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { EmployeeRole } from '../../src/backoffice/contracts/employee'
import { WorkspaceAccessProvider } from '../../src/backoffice/lib/workspaceAccess'
import HelpDeskPage from '../../src/backoffice/pages/HelpDeskPage'
import { MenuGuard } from '../../src/backoffice/pages/ModulePages'
import { ShellRoute } from '../../src/backoffice/ShellRoute'
import { employee, type FakeServer } from './helpdesk-fake'

/** 当前地址（路径 + 查询），随路由变化更新。 */
export const location = { current: '' }

function LocationProbe() {
  const here = useLocation()
  useEffect(() => {
    location.current = `${here.pathname}${here.search}`
  }, [here.pathname, here.search])
  return null
}

export async function renderHelpDesk(server: FakeServer, options: { role?: EmployeeRole; path: string }) {
  server.on('GET', '/api/session', { data: { employee: employee(options.role ?? 'ADMIN'), sidebarState: 'expanded' } })
  const view = render(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={[options.path]}>
          <Routes>
            <Route path="/:locale" element={<ShellRoute />}>
              <Route
                path="help-desk/:ticketId?"
                element={
                  <MenuGuard menu="helpDesk">
                    <WorkspaceAccessProvider menu="helpDesk">
                      <HelpDeskPage />
                    </WorkspaceAccessProvider>
                  </MenuGuard>
                }
              />
            </Route>
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
  )
  // 外壳读完会话、页头出现后才算渲染完成
  await screen.findByRole('tablist')
  return view
}
