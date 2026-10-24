/**
 * 统一图标集：全部基于 16px 网格、currentColor 描边，
 * 避免混用 emoji 造成不同平台字形不一致（设计稿为线性图标）。
 */

type IconProps = {
  size?: number;
  className?: string;
};

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

export function CourseIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 6.5h11" />
    </svg>
  );
}

export function KnowledgeIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M2.5 4.2 8 2.5l5.5 1.7-5.5 1.7z" />
      <path d="M2.5 8 8 9.7 13.5 8" />
      <path d="M2.5 11.3 8 13l5.5-1.7" />
    </svg>
  );
}

export function AiTutorIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M8 2v2.2M8 11.8V14M2 8h2.2M11.8 8H14" />
      <path d="m4.1 4.1 1.5 1.5M10.4 10.4l1.5 1.5M11.9 4.1l-1.5 1.5M5.6 10.4l-1.5 1.5" />
      <circle cx="8" cy="8" r="1.6" />
    </svg>
  );
}

export function OrderIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      {/* 展开的书 */}
      <path d="M8 4.3C6.7 3.3 4.7 2.9 2.7 2.9v9.3c2 0 4 .4 5.3 1.4 1.3-1 3.3-1.4 5.3-1.4V2.9c-2 0-4 .4-5.3 1.4z" />
      <path d="M8 4.3v9.3" />
    </svg>
  );
}

export function ReportingIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      {/* 带箭头的时钟（历史/报表） */}
      <path d="M13.4 8a5.4 5.4 0 1 1-1.9-4.1" />
      <path d="M13.4 2.2v2.2h-2.2" />
      <path d="M8 5.4V8l1.9 1.2" />
    </svg>
  );
}

export function StudentIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="6.2" cy="5.4" r="2.1" />
      <path d="M2.4 13c0-2 1.7-3.5 3.8-3.5 1 0 1.9.4 2.6 1" />
      <path d="M12.1 5.3a2 2 0 0 1 0 3.9" />
      <path d="M11.6 10.6v3M10.1 12.1h3" />
    </svg>
  );
}

export function HelpDeskIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2.2" y="2.8" width="11.6" height="8.6" rx="1.8" />
      <path d="M6.6 6.2 9.4 8l-2.8 1.8z" />
      <path d="M5.6 14h4.8" />
    </svg>
  );
}

export function SettingsIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M12.7 9.6a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 1 1-1.7 1.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.2a1.2 1.2 0 1 1-2.4 0v-.1a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 1 1-1.7-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H2.7a1.2 1.2 0 1 1 0-2.4h.1a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 1 1 1.7-1.7l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V2.7a1.2 1.2 0 1 1 2.4 0v.1a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 1 1 1.7 1.7l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.2a1.2 1.2 0 1 1 0 2.4h-.1a1 1 0 0 0-.9.6z" />
    </svg>
  );
}

export function KeyIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="6.2" cy="9.8" r="2.6" />
      <path d="m8.2 7.8 4.6-4.6M11 5l1.4 1.4M9.6 6.4l1.4 1.4" />
    </svg>
  );
}

export function SignOutIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6.4 13H4.2A1.4 1.4 0 0 1 2.8 11.6V4.4A1.4 1.4 0 0 1 4.2 3h2.2" />
      <path d="M10.4 11 13.4 8l-3-3M13 8H6.6" />
    </svg>
  );
}

export function MailIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2.2" y="3.6" width="11.6" height="8.8" rx="1.6" />
      <path d="m2.8 4.8 4.5 3.2a1.3 1.3 0 0 0 1.4 0l4.5-3.2" />
    </svg>
  );
}

export function LockIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="3.4" y="6.8" width="9.2" height="6.6" rx="1.6" />
      <path d="M5.6 6.8V5.2a2.4 2.4 0 0 1 4.8 0v1.6" />
    </svg>
  );
}

export function EyeIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M1.8 8s2.3-3.6 6.2-3.6S14.2 8 14.2 8s-2.3 3.6-6.2 3.6S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.7" />
    </svg>
  );
}

export function EyeOffIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6.4 4.6A6.6 6.6 0 0 1 8 4.4c3.9 0 6.2 3.6 6.2 3.6a11 11 0 0 1-1.9 2.3M4.3 5.9A11.2 11.2 0 0 0 1.8 8s2.3 3.6 6.2 3.6c.7 0 1.4-.1 2-.3" />
      <path d="M6.7 6.7a1.8 1.8 0 0 0 2.5 2.5M2.6 2.6l10.8 10.8" />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m3.4 8.4 3 3 6.2-6.6" />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="m10.4 10.4 3 3" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m4.2 6.2 3.8 3.8 3.8-3.8" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M9.6 4.2 5.8 8l3.8 3.8" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6.4 4.2 10.2 8l-3.8 3.8" />
    </svg>
  );
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </svg>
  );
}

export function DotsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="8" cy="3.4" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="8" cy="12.6" r="1.2" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}

export function PanelToggleIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2" y="2.6" width="12" height="10.8" rx="2" />
      <path d="M6.4 2.6v10.8" />
      <path d="M11.4 6.2 9.9 8l1.5 1.8" />
    </svg>
  );
}

export function ShieldIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M8 2.4 13 4v4c0 2.6-2 4.7-5 5.6-3-1-5-3-5-5.6V4z" />
      <path d="m5.9 8 1.5 1.5 2.7-2.9" />
    </svg>
  );
}

export function DiamondIcon({ size = 20, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 1.6 14.4 8 8 14.4 1.6 8z" />
    </svg>
  );
}

export function GraduationCapIcon({ size = 20, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3.5 22 8l-10 4.5L2 8z" />
      <path d="M6 10.2v4.4c0 1.9 2.7 3.4 6 3.4s6-1.5 6-3.4v-4.4" />
      <path d="M22 8v5" />
    </svg>
  );
}

export function BrandMark({ size = 42 }: { size?: number }) {
  return (
    <span className="brandMarkSvg" aria-hidden="true" style={{ width: size, height: size }}>
      <svg
        width={size * 0.6}
        height={size * 0.6}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* 学士帽：设计稿顶栏 logo */}
        <path d="M12 3.5 22 8l-10 4.5L2 8z" />
        <path d="M6 10.2v4.4c0 1.9 2.7 3.4 6 3.4s6-1.5 6-3.4v-4.4" />
        <path d="M22 8v5" />
      </svg>
    </span>
  );
}
