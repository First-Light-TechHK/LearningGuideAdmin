/**
 * Help Desk 小图标（Figma 1324:2 的 search / filter / calendar，v2 的 flag / bot，14–16px 描边）。
 * Figma 资源下载在本环境被代理拦截，这里按同名描边图标重画，尺寸与颜色对齐设计稿（待视觉验收）。
 */
type IconProps = { size?: number; className?: string }

function stroke(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  }
}

export function HdSearchIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  )
}

export function HdFilterIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z" />
    </svg>
  )
}

export function HdCalendarIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

export function HdCloseIcon({ size = 10, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

/** Flag follow-up（v2 §3d）：左栏行内的小旗子。带 label 时是有名字的图片，否则只作装饰。 */
export function HdFlagIcon({ size = 12, className, label }: IconProps & { label?: string }) {
  const props = stroke(size, className)
  return (
    <svg {...props} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d="M4 22V4" />
      <path d="M4 4h12l-2 4 2 4H4" />
    </svg>
  )
}

/** AI 客服助手头像里的机器人（Figma 1324:2 AI 块右侧，21px）。 */
export function HdBotIcon({ size = 21, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4" />
      <circle cx="12" cy="3" r="1" />
      <path d="M9 13v1" />
      <path d="M15 13v1" />
      <path d="M2 13v2" />
      <path d="M22 13v2" />
    </svg>
  )
}
