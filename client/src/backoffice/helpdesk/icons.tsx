/**
 * Help Desk 小图标（Figma 1324:2 的 search / filter / file / check-circle / calendar，14–16px 描边）。
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

export function HdFileIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

export function HdCheckCircleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
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

export function HdArrowIcon({ size = 14, className, direction }: IconProps & { direction: 'up' | 'down' }) {
  return (
    <svg {...stroke(size, className)}>
      {direction === 'up' ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M19 12l-7 7-7-7" />}
    </svg>
  )
}
