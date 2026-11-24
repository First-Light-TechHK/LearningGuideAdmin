import type { CapabilityId } from '../../../common/capabilities';
import type { ErrorCode } from '../../contracts/envelope';
import { tryRecordAuditEvent } from '../../repositories/auditRepository';
import * as employeeRepository from '../../repositories/employeeRepository';
import * as featureGrantRepository from '../../repositories/featureGrantRepository';
import {
  FEATURE_CATALOG,
  effectiveModuleLevel,
  isFeatureKey,
  resolveBaselineFeatures,
  resolveEffectiveFeatures,
  type EffectiveFeature,
  type FeatureCatalogEntry,
  type FeatureGrantMap,
  type FeatureKey,
} from './features';

/**
 * 账号级功能权限 API 的领域服务（owner 2026-11-20）：
 * - GET 返回 catalog + 显式 grants + 每项 effective；
 * - PUT 全量替换显式开关，校验 key，写 EMPLOYEE_FEATURES_CHANGED 审计（before/after）；
 * - 最后一个可用 Admin 的账号管理不能被关掉（含给自己关掉导致锁死）。
 */

export type FeatureGrantView = {
  feature: FeatureKey;
  allowed: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

export type EmployeeFeaturesView = {
  employeeId: string;
  catalog: FeatureCatalogEntry[];
  grants: FeatureGrantView[];
  effective: EffectiveFeature[];
  /** 角色基线（不包含账号开关），用于解释 INHERIT 行。 */
  baseline: EffectiveFeature[];
};

export type SaveEmployeeFeaturesOutcome =
  | { ok: true; view: EmployeeFeaturesView }
  | {
      ok: false;
      code: Extract<ErrorCode, 'INVALID_INPUT' | 'PROTECTED_ADMIN_ACCOUNT'>;
    };

const CATALOG_ORDER = new Map<FeatureKey, number>(
  FEATURE_CATALOG.map((entry, index) => [entry.key, index]),
);

function sortGrants<T extends { feature: FeatureKey }>(grants: T[]): T[] {
  return grants.sort(
    (a, b) =>
      (CATALOG_ORDER.get(a.feature) ?? Number.MAX_SAFE_INTEGER) -
      (CATALOG_ORDER.get(b.feature) ?? Number.MAX_SAFE_INTEGER),
  );
}

async function buildView(
  employee: employeeRepository.EmployeeRecord,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): Promise<EmployeeFeaturesView> {
  const rows = await featureGrantRepository.listByEmployee(employee.employeeId);
  const grants: FeatureGrantView[] = [];
  const map = new Map<FeatureKey, boolean>();
  for (const row of rows) {
    if (!isFeatureKey(row.feature)) continue;
    map.set(row.feature, row.allowed);
    grants.push({
      feature: row.feature,
      allowed: row.allowed,
      updatedAt:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : new Date(row.updatedAt).toISOString(),
      updatedBy: row.updatedBy,
    });
  }
  return {
    employeeId: employee.employeeId,
    catalog: FEATURE_CATALOG.map((entry) => ({ ...entry })),
    grants: sortGrants(grants),
    effective: resolveEffectiveFeatures({
      role: employee.role,
      grants: map,
      enabledCapabilities,
    }),
    baseline: resolveBaselineFeatures(employee.role),
  };
}

/** 校验 PUT 的 grants 数组：必须是已知 key、布尔值、无重复。 */
function parseGrantInput(
  raw: unknown,
): Array<{ feature: FeatureKey; allowed: boolean }> | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<FeatureKey>();
  const parsed: Array<{ feature: FeatureKey; allowed: boolean }> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return null;
    const feature = (item as { feature?: unknown }).feature;
    const allowed = (item as { allowed?: unknown }).allowed;
    if (!isFeatureKey(feature) || typeof allowed !== 'boolean') return null;
    if (seen.has(feature)) return null;
    seen.add(feature);
    parsed.push({ feature, allowed });
  }
  return sortGrants(parsed);
}

function serializeGrantMap(map: FeatureGrantMap): string {
  return JSON.stringify(
    FEATURE_CATALOG.filter((entry) => map.has(entry.key)).map((entry) => ({
      feature: entry.key,
      allowed: map.get(entry.key),
    })),
  );
}

export async function getEmployeeFeatures(
  employeeId: string,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): Promise<EmployeeFeaturesView | null> {
  const employee = await employeeRepository.findById(employeeId);
  if (!employee) return null;
  return buildView(employee, enabledCapabilities);
}

export async function saveEmployeeFeatures(input: {
  employeeId: string;
  /** PUT body 里的 grants 原始值（未校验）。 */
  grants: unknown;
  actorEmployeeId: string;
  ipAddress: string | null;
  enabledCapabilities: ReadonlySet<CapabilityId>;
}): Promise<SaveEmployeeFeaturesOutcome> {
  const employee = await employeeRepository.findById(input.employeeId);
  if (!employee) return { ok: false, code: 'INVALID_INPUT' };

  const parsed = parseGrantInput(input.grants);
  if (!parsed) return { ok: false, code: 'INVALID_INPUT' };

  const afterMap: FeatureGrantMap = new Map(
    parsed.map((grant) => [grant.feature, grant.allowed]),
  );

  const usable =
    employee.accountStatus === 'ACTIVE' &&
    employee.emailVerification === 'VERIFIED';

  // 最后一个可用 Admin：在 advisory lock 内读取 before、判定并替换，
  // 并发保存时串行执行，不会两个请求都看到「对方仍可用」而一起关掉账号管理。
  const guarded = await featureGrantRepository.replaceForEmployeeGuarded({
    employeeId: employee.employeeId,
    grants: parsed,
    updatedBy: input.actorEmployeeId,
    decide: async (beforeMap, client) => {
      const beforeAccounts = effectiveModuleLevel(
        employee.role,
        'module.accounts',
        beforeMap,
        input.enabledCapabilities,
      );
      const afterAccounts = effectiveModuleLevel(
        employee.role,
        'module.accounts',
        afterMap,
        input.enabledCapabilities,
      );
      if (
        !usable ||
        employee.role !== 'ADMIN' ||
        beforeAccounts !== 'FULL' ||
        afterAccounts === 'FULL'
      )
        return true;
      const others =
        await featureGrantRepository.countOtherAccountsCapableAdminsWithin(
          client,
          employee.employeeId,
        );
      return others > 0;
    },
  });
  if (!guarded.applied) {
    return { ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' };
  }
  const beforeMap = guarded.before;

  await tryRecordAuditEvent({
    eventName: 'EMPLOYEE_FEATURES_CHANGED',
    actorEmployeeId: input.actorEmployeeId,
    targetEmployeeId: employee.employeeId,
    action: 'UPDATE_EMPLOYEE',
    oldValue: serializeGrantMap(beforeMap),
    newValue: serializeGrantMap(afterMap),
    result: 'SUCCESS',
    ipAddress: input.ipAddress,
  });

  return {
    ok: true,
    view: await buildView(employee, input.enabledCapabilities),
  };
}

const requestGrantsCache = new WeakMap<object, Promise<FeatureGrantMap>>();

/** 单请求内缓存该员工的功能开关（守卫解析会话后加载一次，会话接口复用）。 */
export function grantsForRequest(
  request: object,
  employeeId: string,
): Promise<FeatureGrantMap> {
  let cached = requestGrantsCache.get(request);
  if (!cached) {
    cached = featureGrantRepository.mapForEmployee(employeeId);
    requestGrantsCache.set(request, cached);
  }
  return cached;
}
