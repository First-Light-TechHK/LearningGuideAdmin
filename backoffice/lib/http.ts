import { NextResponse } from "next/server";

import { ERROR_STATUS, fail, ok, type Envelope, type ErrorCode } from "@/contracts/envelope";

export function jsonOk<T>(data: T, message = "OK"): NextResponse<Envelope<T>> {
  return NextResponse.json(ok(data, message), { status: 200 });
}

export function jsonFail(error: ErrorCode, message: string): NextResponse<Envelope<never>> {
  return NextResponse.json(fail(error, message), { status: ERROR_STATUS[error] });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

export function readNumber(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}
