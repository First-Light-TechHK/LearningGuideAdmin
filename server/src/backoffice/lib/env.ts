import { randomBytes } from 'node:crypto';

/**
 * BackOffice 运行参数。全部延迟求值：缺失时在请求期报错，不影响 KS/AI Tutor 启动。
 */
export type AppEnvName = 'DEV' | 'SIT' | 'UAT' | 'PPE' | 'PROD';

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function databaseUrl(): string {
  return required('DATABASE_URL');
}

let persistedSecret: string | undefined;

/** 由 BackofficeModule 启动时注入：SESSION_SECRET 未配置时使用库里持久化的随机密钥。 */
export function usePersistedSessionSecret(secret: string): void {
  persistedSecret = secret;
}

export function configuredSessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET?.trim() ?? '';
  return secret.length >= 32 ? secret : null;
}

export function sessionSecret(): string {
  const secret = configuredSessionSecret() ?? persistedSecret;
  if (!secret) throw new Error('Session secret is not initialised');
  return secret;
}

export function generateSecret(): string {
  return randomBytes(48).toString('base64url');
}

export function appEnvName(): AppEnvName {
  const raw = (process.env.APP_ENV ?? 'DEV').toUpperCase();
  return raw === 'SIT' || raw === 'UAT' || raw === 'PPE' || raw === 'PROD'
    ? raw
    : 'DEV';
}

/** 邮件里的激活/重置链接根地址；未配置时由控制器按请求来源传入。 */
export function configuredAppBaseUrl(): string | null {
  const raw = process.env.BACKOFFICE_APP_URL?.trim() ?? '';
  return raw === '' ? null : raw.replace(/\/+$/, '');
}

/** 本地开发把邮件内容打到日志，便于走通激活流程。 */
export function isDevRuntime(): boolean {
  return appEnvName() === 'DEV' && process.env.NODE_ENV !== 'production';
}
