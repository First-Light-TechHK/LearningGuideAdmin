import axios from 'axios'
import { notifySessionChanged } from '../backoffice/lib/navigation'

/**
 * axios 实例（开发文档 §6.1）。dev 环境经 vite 代理访问 /api（§5.1 全局前缀）。
 * 所有响应为 §5.3 统一信封 { success, data, error, message }，
 * 此处拦截器直接解包 data，失败时以 error.message 抛出（已由后端过滤器脱敏）。
 */
export const http = axios.create({
  baseURL: '/api',
  timeout: 15000,
})

/** §5.3 统一响应信封 */
export interface ApiEnvelope<T> {
  success: boolean
  data: T
  error: { code: string; message: string } | null
  message: string
}

http.interceptors.response.use(
  (response) => {
    const body = response.data as ApiEnvelope<unknown>
    if (body && body.success === true) {
      response.data = body.data
    }
    return response
  },
  (error) => {
    // 会话过期 / 被停用：通知 BackOffice 外壳重新读取会话（会跳回登录页）
    if (error.response?.status === 401) notifySessionChanged()
    // 后端错误信封：{ success:false, error:{ code, message } }
    const envelope = error.response?.data as ApiEnvelope<null> | undefined
    if (envelope?.error) {
      const err = new Error(envelope.error.message) as Error & {
        code?: string
      }
      err.code = envelope.error.code
      return Promise.reject(err)
    }
    return Promise.reject(error)
  },
)
