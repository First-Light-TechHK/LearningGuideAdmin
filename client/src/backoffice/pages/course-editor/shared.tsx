import { useCallback, useState } from 'react';

export const L = (locale: string, zh: string, en: string) =>
  locale.startsWith('zh') ? zh : en;

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

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function parseTime(value: string): number {
  const [m, s] = value.split(':').map((part) => Number(part));
  if (Number.isNaN(m)) return 0;
  return Math.max(0, Math.round((m || 0) * 60 + (s || 0)));
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
