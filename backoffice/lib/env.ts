/**
 * 环境变量集中读取，全部延迟求值：
 * 缺失时在请求期抛错，而不是让 `next build` 直接失败。
 */
export type AppEnvName = "DEV" | "SIT" | "UAT" | "PPE" | "PROD";

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function databaseUrl(): string {
  return required("DATABASE_URL");
}

export function sessionSecret(): string {
  const secret = required("SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  return secret;
}

export function appEnvName(): AppEnvName {
  const raw = (process.env.APP_ENV ?? "DEV").toUpperCase();
  return raw === "SIT" || raw === "UAT" || raw === "PPE" || raw === "PROD" ? raw : "DEV";
}

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3200").replace(/\/+$/, "");
}

/** 开发态允许把激活/重置链接打到服务端日志，便于本地走通流程。 */
export function isDevRuntime(): boolean {
  return appEnvName() === "DEV" && process.env.NODE_ENV !== "production";
}
