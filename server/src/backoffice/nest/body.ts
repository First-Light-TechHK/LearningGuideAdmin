export type JsonBody = Record<string, unknown>;

export function asBody(raw: unknown): JsonBody {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as JsonBody)
    : {};
}

export function readString(body: JsonBody, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export function readOptionalString(
  body: JsonBody,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
