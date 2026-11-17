import { BadRequestException } from '@nestjs/common';

/**
 * 课程模块没有 DTO 类，请求体直接是 `unknown`。这些守卫把「形状不对」变成 400，
 * 而不是在服务里炸出 500。只拒绝畸形输入（类型错、负数、非整数、不在本课程的 id）；
 * 空值或没填完的值照常保存，由完整性规则报告（PRD：没填完也可以保存）。
 *
 * 每个守卫抛 `400 VALIDATION_ERROR`，`details.field` 指出是哪个字段；
 * 调用方可以换错误码并追加 details（例如 `INVALID_TIME` 带 `row`）。
 */
export interface GuardContext {
  code?: string;
  details?: Record<string, unknown>;
}

function refuse(
  field: string,
  message: string,
  context: GuardContext | undefined,
  extra?: Record<string, unknown>,
): never {
  throw new BadRequestException({
    code: context?.code ?? 'VALIDATION_ERROR',
    message,
    details: { field, ...(context?.details ?? {}), ...(extra ?? {}) },
  });
}

/** 必须是数组；`emptyIfMissing` 时没传（undefined / null）按空数组。 */
export function requireArray<T = unknown>(
  value: unknown,
  field: string,
  options: { emptyIfMissing?: boolean } & GuardContext = {},
): T[] {
  if (Array.isArray(value)) return value as T[];
  if ((value === undefined || value === null) && options.emptyIfMissing) {
    return [];
  }
  return refuse(field, `${field} must be a list.`, options);
}

/** 可选字符串：没传或 null 得到 undefined；空字符串原样保留；其他类型 400。 */
export function optionalString(
  value: unknown,
  field: string,
  options: { max?: number } & GuardContext = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    return refuse(field, `${field} must be text.`, options);
  }
  if (options.max !== undefined && value.length > options.max) {
    return refuse(
      field,
      `${field} is longer than ${options.max} characters.`,
      options,
    );
  }
  return value;
}

/**
 * 可选的非负整数（秒数等）：没传、null、空字符串得到 null；
 * 整数或整数字符串返回数字；负数、小数、NaN、其他文字 400。
 */
export function optionalNonNegativeInt(
  value: unknown,
  field: string,
  options: GuardContext = {},
): number | null {
  if (value === undefined || value === null || value === '') return null;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    return refuse(field, `${field} must be a whole number.`, options);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    return refuse(
      field,
      `${field} must be a whole number of 0 or more.`,
      options,
    );
  }
  return n;
}

/** 必填的 id：非空字符串（去掉首尾空白）。 */
export function requireId(
  value: unknown,
  field: string,
  options: GuardContext = {},
): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return refuse(field, `${field} is required.`, options);
}

/** 值必须在允许列表里。 */
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  options: GuardContext = {},
): T {
  if (
    typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  return refuse(
    field,
    `${field} must be one of ${allowed.join(', ')}.`,
    options,
    {
      allowed: [...allowed],
    },
  );
}
