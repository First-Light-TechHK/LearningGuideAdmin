import { useCallback, useState } from 'react';
import { formatDateTime } from '../../lib/i18n/format';

export const L = (locale: string, zh: string, en: string) =>
  locale.startsWith('zh') ? zh : en;

/** 学习语言代码 → 展示名。 */
export function languageLabel(locale: string, code: string): string {
  if (code === 'zh-CN') return L(locale, '中文', 'Chinese');
  if (code === 'en-GB' || code === 'en') return L(locale, '英文', 'English');
  return code;
}

/** 学习模式枚举 → 展示名。 */
export function learningModeLabel(locale: string, mode: string): string {
  switch (mode) {
    case 'VIDEO_ONLY': return L(locale, '仅视频', 'Video only');
    case 'TEXT_ONLY': return L(locale, '仅文字', 'Text only');
    case 'VIDEO_AND_TEXT': return L(locale, '视频与文字', 'Video & text');
    default: return mode;
  }
}

/** 线上状态枚举 → 展示名。 */
export function liveStatusLabel(locale: string, status: string): string {
  switch (status) {
    case 'ONLINE': return L(locale, '在线', 'Online');
    case 'HIDDEN': return L(locale, '已隐藏', 'Hidden');
    case 'OFFLINE': return L(locale, '已下线', 'Offline');
    default: return status;
  }
}

/** 试看行状态枚举 → 展示名。 */
export function trialStatusLabel(locale: string, status: string): string {
  switch (status) {
    case 'READY': return L(locale, '就绪', 'Ready');
    case 'RE_CONFIRM': return L(locale, '需重新确认', 'Re-confirm');
    case 'LOCKED': return L(locale, '未选入', 'Locked');
    default: return status;
  }
}

/** 展品类型枚举 → 展示名。 */
export function exhibitTypeLabel(locale: string, type: string): string {
  switch (type) {
    case 'IMAGE': return L(locale, '图片', 'Image');
    case 'VIDEO': return L(locale, '视频', 'Video');
    case 'MODEL3D': return L(locale, '3D 模型', '3D');
    default: return type;
  }
}

/** 阅读类型枚举 → 展示名。 */
export function readingTypeLabel(locale: string, type: string): string {
  switch (type) {
    case 'BOOK': return L(locale, '图书', 'Book');
    case 'ARTICLE': return L(locale, '文章', 'Article');
    case 'PAPER': return L(locale, '论文', 'Paper');
    case 'OTHER': return L(locale, '其他', 'Other');
    default: return type;
  }
}

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 10,
  border: '1px solid #d9e0ea',
  borderRadius: 8,
  boxSizing: 'border-box',
  fontSize: 14,
};

export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontWeight: 600,
  margin: '14px 0 6px',
  color: '#25314C',
  fontSize: 13,
};

export const buttonStyle: React.CSSProperties = {
  padding: '8px 14px',
  border: '1px solid #d9e0ea',
  borderRadius: 8,
  background: '#fff',
  cursor: 'pointer',
  fontSize: 14,
};

export const primaryBtn: React.CSSProperties = {
  ...buttonStyle,
  background: '#2B58C8',
  color: '#fff',
  border: '1px solid #2B58C8',
};

export const dangerBtn: React.CSSProperties = {
  ...buttonStyle,
  color: '#b42318',
  borderColor: '#f0c2be',
};

export const card: React.CSSProperties = {
  border: '1px solid #E8EDF5',
  borderRadius: 14,
  padding: 20,
  background: '#fff',
  marginTop: 18,
};

export const Chip = ({
  children,
  tone = 'grey',
}: {
  children: React.ReactNode;
  tone?: 'grey' | 'green' | 'amber' | 'red' | 'blue';
}) => (
  <span
    style={{
      fontSize: 12,
      padding: '2px 10px',
      borderRadius: 999,
      background:
        tone === 'green'
          ? '#E7F6EC'
          : tone === 'amber'
            ? '#FFF6E5'
            : tone === 'red'
              ? '#FDECEC'
              : tone === 'blue'
                ? '#EEF3FF'
                : '#EEF1F6',
      color:
        tone === 'green'
          ? '#1E7A3C'
          : tone === 'amber'
            ? '#9A6B00'
            : tone === 'red'
              ? '#b42318'
              : tone === 'blue'
                ? '#2B58C8'
                : '#5A6577',
    }}
  >
    {children}
  </span>
);

export function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(value: string | null | undefined, locale: string): string {
  return formatDateTime(locale, value);
}

/**
 * 完成度缺失项来自服务端的英文句式（与 Publish 门禁共用）。界面面向运营，
 * 这里把常见句式翻成中文，认不出的保留原文，避免漏信息。
 */
export function localizeMissing(locale: string, message: string): string {
  const body = message.replace(/^Lesson [^:]+:\s*/, '');
  if (!locale.startsWith('zh')) return body;
  const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/^title is required \((.+)\)$/, (m) => `标题缺失（${m[1]}）`],
    [/^description is required \((.+)\)$/, (m) => `课时简介缺失（${m[1]}）`],
    [/^video is required \((.+)\)$/, (m) => `视频缺失（${m[1]}）`],
    [/^video duration is missing \((.+)\)$/, (m) => `视频时长缺失（${m[1]}，上传视频后自动读取）`],
    [/^add at least 1 video learning point \((.+)\)$/, (m) => `至少 1 个视频学习点（${m[1]}）`],
    [/^text content is required \((.+)\)$/, (m) => `文字内容缺失（${m[1]}）`],
    [/^add at least 1 text learning point \((.+)\)$/, (m) => `至少 1 个文字学习点（${m[1]}）`],
    [/^missing (.+) content$/, (m) => `缺少 ${m[1]} 语言内容`],
    [/^knowledge question (\d+) needs a question$/, (m) => `知识测试第 ${m[1]} 题缺少题目`],
    [/^knowledge question (\d+) needs a reference answer$/, (m) => `知识测试第 ${m[1]} 题缺少参考答案`],
    [/^application test needs a question$/, () => '应用测试缺少题目'],
    [/^application test needs a reference answer$/, () => '应用测试缺少参考答案'],
  ];
  for (const [pattern, format] of patterns) {
    const match = body.match(pattern);
    if (match) return format(match);
  }
  return body;
}

export function parseTime(value: string): number {
  const [m, s] = value.split(':').map((part) => Number(part));
  if (Number.isNaN(m)) return 0;
  return Math.max(0, Math.round((m || 0) * 60 + (s || 0)));
}

export function fmtTimeInput(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 解析时间输入：`m:ss` / `mm:ss` 按“分:秒”理解；`h:mm:ss` 按“时:分:秒”理解。
 * 不带冒号的纯数字按总秒数理解（如 180 → 3:00），方便按秒快速输入。
 */
export function parseTimeInput(value: string): number | null {
  const trimmed = value.trim().replace(/：/g, ':');
  if (!trimmed) return null;
  const parts = trimmed.split(':').map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const seconds =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? parts[0] * 60 + parts[1]
        : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Math.max(0, Math.round(seconds));
}

/** 时间输入框：编辑时保留原文，失焦/回车时才解析，避免边打字边重排格式。 */
export function TimeInput({
  seconds,
  onChange,
  disabled,
  placeholder = 'mm:ss',
  style,
}: {
  seconds: number | null | undefined;
  onChange: (seconds: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? fmtTimeInput(seconds);
  return (
    <input
      value={display}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={() => setDraft(fmtTimeInput(seconds))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return;
        onChange(parseTimeInput(draft));
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      style={style}
    />
  );
}

export function Modal({
  title,
  children,
  onClose,
  width = 560,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  width?: number;
}) {
  return (
    <div
      className="modalBackdrop"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.35)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="modal"
        style={{ width: `min(${width}px, 94vw)`, maxHeight: '90vh', overflow: 'auto' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalHead">
          <div className="modalTitle">{title}</div>
          <button type="button" className="modalClose" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modalBody">{children}</div>
      </div>
    </div>
  );
}

export function useForceRerender() {
  const [, set] = useState(0);
  return useCallback(() => set((value) => value + 1), []);
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="fieldLabel">{label}</label>
      {children}
      {hint && <div className="fieldHint">{hint}</div>}
    </div>
  );
}
