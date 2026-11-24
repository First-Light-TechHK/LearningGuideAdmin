import type { Locale } from './i18n/config'
import { t } from './i18n/messages'

/**
 * 当前环境的身份：外壳的“墙”和钥石读它。
 * kind 只认 APP_ENV（GET /api/health 的 environment）：SANDBOX = sandbox，PROD / PRODUCTION = production，
 * 其余（DEV、SIT、UAT、PPE、读取失败）一律 neutral，不借用 Sandbox / Production 的颜色。
 * label 来自 GET /api/backoffice/environment，只用于 neutral 环境的显示名。
 */
export type EnvironmentKind = 'sandbox' | 'production' | 'neutral'

export type EnvironmentIdentity = {
  kind: EnvironmentKind
  /** APP_ENV 大写；health 读不到时为 null */
  code: string | null
  /** 环境端点的 label；没有时为 null */
  label: string | null
  /** true while /api/health has not answered yet: neutral wall, keystone without a name (not "Unknown") */
  pending?: boolean
}

const NEUTRAL_UNKNOWN: EnvironmentIdentity = { kind: 'neutral', code: null, label: null }

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? null : trimmed
}

export function resolveEnvironment(
  appEnv: string | null | undefined,
  label: string | null | undefined,
): EnvironmentIdentity {
  // undefined = health has not answered yet; null = it answered and failed
  if (appEnv === undefined) return { kind: 'neutral', code: null, label: clean(label), pending: true }
  const code = clean(appEnv)?.toUpperCase() ?? null
  const kind: EnvironmentKind =
    code === 'SANDBOX' ? 'sandbox' : code === 'PROD' || code === 'PRODUCTION' ? 'production' : 'neutral'
  return { kind, code, label: clean(label) }
}

export function environmentName(locale: Locale, identity: EnvironmentIdentity): string {
  if (identity.pending) return ''
  if (identity.kind === 'sandbox') return t(locale, 'shell.environment.sandbox')
  if (identity.kind === 'production') return t(locale, 'shell.environment.production')
  // 服务端在没配 ENVIRONMENT_LABEL 时按版本号规则推出 Sandbox / Production，不是真名，不采用
  const custom = identity.label
  if (custom !== null && !/^(sandbox|production)$/i.test(custom)) return custom
  return identity.code ?? t(locale, 'shell.environment.unknown')
}

let identityCache: EnvironmentIdentity = NEUTRAL_UNKNOWN

export function rememberEnvironmentIdentity(identity: EnvironmentIdentity): void {
  identityCache = identity
}

export function cachedEnvironmentIdentity(): EnvironmentIdentity {
  return identityCache
}
