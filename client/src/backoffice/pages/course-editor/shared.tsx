import { useState } from 'react';
import { fmtTimeInput, parseTimeInput } from './shared-utils';



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


/** 服务器报告的"没填完 / 无效"，红字放在对应的字段或行下面。没有就不显示。 */
export function IssueText({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  return <div data-testid="field-issue" style={{ fontSize: 12, color: '#b42318', marginTop: 4 }}>{children}</div>;
}

/**
 * 时间输入框（受控文本）：保留用户输入的原文，不在输入框里解析、不静默改成 0。
 * 能读成 mm:ss 的由请求层转成秒，读不懂的原样交给服务器，服务器回 INVALID_TIME 和行号，错误挂在这一行。
 */
export function TypedTimeInput({
  text,
  onText,
  placeholder = 'mm:ss',
  invalid,
  style,
  testId,
}: {
  text: string;
  onText: (text: string) => void;
  placeholder?: string;
  invalid?: boolean;
  style?: React.CSSProperties;
  testId?: string;
}) {
  return (
    <input
      data-testid={testId}
      value={text}
      placeholder={placeholder}
      aria-invalid={invalid ? true : undefined}
      onChange={(event) => onText(event.target.value)}
      style={{ ...style, ...(invalid ? { borderColor: '#b42318' } : {}) }}
    />
  );
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


export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="fieldLabel">{label}</label>
      {children}
      {hint && <div className="fieldHint">{hint}</div>}
    </div>
  );
}