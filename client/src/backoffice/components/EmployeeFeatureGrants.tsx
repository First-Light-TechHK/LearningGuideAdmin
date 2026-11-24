import {
  FEATURE_MODES,
  type EmployeeFeatureCatalogEntry,
  type FeatureMode,
} from '../contracts/employee'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * 功能权限三态开关（继承角色 / 允许 / 禁止）。
 * 目录、草稿与生效结果都由调用方从服务端数据准备；本组件只渲染与上报点击，
 * 不自行推断角色基线 —— 生效结果永远以服务端 effective 为准。
 */

const KNOWN_GROUPS = ['module', 'course'] as const

const GROUP_LABEL_KEY: Record<string, string> = {
  module: 'employees.features.groups.module',
  course: 'employees.features.groups.course',
}

/** key → messages 路径：feature key 里的点换成下划线（message 查找本身按点分层）。 */
function featureLabelPath(key: string): string {
  return `employees.features.items.${key.replaceAll('.', '_')}`
}

/** 已知 key 用翻译；服务端新增而前端未翻译的 key 原样显示，不丢行、不错位。 */
function featureLabel(locale: Locale, key: string): string {
  const path = featureLabelPath(key)
  const label = t(locale, path)
  return label === path ? key : label
}

function groupLabel(locale: Locale, group: string): string {
  const path = GROUP_LABEL_KEY[group]
  if (!path) return group
  const label = t(locale, path)
  return label === path ? group : label
}

export function EmployeeFeatureGrants({
  locale,
  catalog,
  draft,
  effective,
  baseline,
  disabled = false,
  onChange,
}: {
  locale: Locale
  catalog: readonly EmployeeFeatureCatalogEntry[]
  draft: Readonly<Record<string, FeatureMode>>
  /** 服务端生效结果 key → allowed；缺失的 key 不显示结论。 */
  effective: Readonly<Record<string, boolean>>
  /** 角色基线（不含账号开关）；INHERIT 行用它解释继承到什么。旧服务端缺省。 */
  baseline?: Readonly<Record<string, { allowed: boolean; level?: string | null }>>
  disabled?: boolean
  onChange: (key: string, mode: FeatureMode) => void
}) {
  const ordered = catalog
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.sortOrder - b.entry.sortOrder || a.index - b.index)
    .map(({ entry }) => entry)
  const extraGroups = ordered
    .map((entry) => entry.group)
    .filter((group, index, all) => !(KNOWN_GROUPS as readonly string[]).includes(group) && all.indexOf(group) === index)
  const groups: string[] = [...KNOWN_GROUPS, ...extraGroups]

  return (
    <div data-testid="employee-feature-grants">
      {groups.map((group) => {
        const items = ordered.filter((entry) => entry.group === group)
        if (items.length === 0) return null
        return (
          <div key={group} data-testid={`feature-group-${group}`} style={{ marginTop: 10 }}>
            <div className="fieldLabel" style={{ marginBottom: 4 }}>
              {groupLabel(locale, group)}
            </div>
            {items.map((item) => {
              const label = featureLabel(locale, item.key)
              const mode = draft[item.key] ?? 'INHERIT'
              const allowed = effective[item.key]
              const inherited = baseline?.[item.key]
              const zh = locale.startsWith('zh')
              const baselineText = inherited
                ? `${zh ? '角色基线' : 'Role baseline'}: ${
                    inherited.level ?? (inherited.allowed ? (zh ? '允许' : 'allowed') : (zh ? '禁止' : 'blocked'))
                  }`
                : null
              return (
                <div
                  key={item.key}
                  data-testid={`feature-row-${item.key}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(140px, 1fr) auto auto',
                    alignItems: 'center',
                    gap: 10,
                    padding: '5px 0',
                  }}
                >
                  <span style={{ fontSize: 13 }}>
                    {label}
                    {mode === 'INHERIT' && baselineText && (
                      <span
                        data-testid={`feature-baseline-${item.key}`}
                        style={{ display: 'block', fontSize: 11, opacity: 0.65 }}
                      >
                        {baselineText}
                      </span>
                    )}
                  </span>
                  <div className="segmented" role="radiogroup" aria-label={label}>
                    {FEATURE_MODES.map((value) => {
                      const selected = mode === value
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={disabled}
                          className={selected ? 'segment segmentSelected' : 'segment'}
                          onClick={() => onChange(item.key, value)}
                        >
                          {t(locale, `employees.features.modes.${value}`)}
                        </button>
                      )
                    })}
                  </div>
                  {allowed === undefined ? (
                    <span aria-hidden="true" />
                  ) : (
                    <span
                      data-testid={`feature-effective-${item.key}`}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 999,
                        whiteSpace: 'nowrap',
                        color: allowed ? '#15803d' : '#b91c1c',
                        background: allowed ? '#dcfce7' : '#fee2e2',
                      }}
                    >
                      {t(locale, allowed ? 'employees.features.effective.on' : 'employees.features.effective.off')}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
