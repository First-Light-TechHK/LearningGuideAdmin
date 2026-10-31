import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './backoffice/backoffice.css'
import App from './App.tsx'
import { startVersionWatch } from './lib/versionWatch'

// 发布后自动换新：服务端注入的构建标识与 /version.json 不一致时自动刷新。
startVersionWatch()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
