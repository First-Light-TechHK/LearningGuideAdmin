import { useEffect, useState } from 'react';

import type { CourseDetail, TrialSettings, TrialRow } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import {
  Chip,
  L,
  buttonStyle,
  card,
  primaryBtn,
} from './shared';

function parseTime(value: string): number | null {
  if (!value.trim()) return null;
  const [m, s] = value.split(':').map((part) => Number(part));
  if (Number.isNaN(m)) return null;
  return Math.max(0, Math.round((m || 0) * 60 + (s || 0)));
}

function fmtTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CourseTrialSection({
  locale,
  courseId,
  trial,
  course,
  busy,
  setBusy,
  onReload,
  onNotice,
  contentLanguage,
}: {
  locale: string;
  courseId: string;
  trial: TrialSettings;
  course: CourseDetail;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
  contentLanguage: string;
}) {
  const [enabled, setEnabled] = useState(trial.enabled);
  const [rows, setRows] = useState<TrialRow[]>(trial.rows);
  const [localPlans, setLocalPlans] = useState(course.plans ?? []);

  useEffect(() => {
    setEnabled(trial.enabled);
    setRows(trial.rows);
  }, [trial]);

  useEffect(() => {
    setLocalPlans(course.plans ?? []);
  }, [course]);

  function toggleRow(lessonId: string) {
    setRows((current) => {
      const index = current.findIndex((row) => row.lessonId === lessonId);
      if (index < 0) return current;
      const next = current.map((row, rowIndex) => (rowIndex === index ? { ...row, inTrial: !row.inTrial } : row));
      const target = next[index];
      if (target.inTrial) {
        for (let i = 0; i < index; i++) next[i] = { ...next[i], inTrial: true };
      } else {
        for (let i = index; i < next.length; i++) next[i] = { ...next[i], inTrial: false };
      }
      return next;
    });
  }

  function updateRow(lessonId: string, patch: Partial<TrialRow>) {
    setRows((current) => current.map((row) => (row.lessonId === lessonId ? { ...row, ...patch } : row)));
  }

  async function saveTrial() {
    setBusy(true);
    const payload = rows
      .filter((row) => row.inTrial)
      .map((row) => ({
        lessonId: row.lessonId,
        videoCutoffSeconds: row.videoCutoffSeconds,
        textCutoffLearningPointId: row.textCutoffLearningPointId,
        videoCutoffByLanguage: {
          ...(row.videoCutoffByLanguage ?? {}),
          [contentLanguage]: row.videoCutoffSeconds,
        },
        textCutoffByLanguage: {
          ...(row.textCutoffByLanguage ?? {}),
          [contentLanguage]: row.textCutoffLearningPointId,
        },
      }));
    const saved = await boRequest(`/api/backoffice/courses/${courseId}/trial`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, rows: payload }),
    });
    setBusy(false);
    if (saved.success) {
      onNotice(L(locale, '试看设置已保存，立即在本环境网站生效（不生成版本）。', 'Trial settings saved and effective immediately (no version created).'));
      await onReload();
    } else {
      onNotice(`${L(locale, '保存失败', 'Save failed')}: ${saved.message ?? saved.error}`);
    }
  }

  function addPlan() {
    setLocalPlans((current) => [
      ...current,
      {
        id: `new-${Date.now()}`,
        name: '',
        termMonths: 1,
        amountMinor: 1000,
        currency: 'usd',
        stripeLookupKey: null,
        stripeProductId: null,
        stripePriceId: null,
        lastSyncedAt: null,
        syncError: null,
      },
    ]);
  }

  async function savePlans() {
    setBusy(true);
    const result = await boRequest<{ plans: typeof localPlans; sync: Array<{ status: string; error?: string }> }>(`/api/backoffice/courses/${courseId}/plans`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plans: localPlans.map((plan) => ({
          id: plan.id.startsWith('new-') ? undefined : plan.id,
          name: plan.name,
          termMonths: Number(plan.termMonths),
          amountMinor: Number(plan.amountMinor),
          currency: plan.currency,
        })),
      }),
    });
    setBusy(false);
    if (result.success) {
      const failed = result.data.sync.filter((entry) => entry.status === 'FAILED' || entry.status === 'NOT_CONFIGURED');
      onNotice(
        failed.length
          ? `Plans saved. Stripe sync: ${failed.map((entry) => entry.error ?? entry.status).join('; ')}`
          : L(locale, '套餐已保存，Stripe 价格已同步。', 'Plans saved and Stripe prices synced.'),
      );
      await onReload();
    } else {
      onNotice(`${L(locale, '保存失败', 'Save failed')}: ${result.message ?? result.error}`);
    }
  }

  async function retrySync(planId: string) {
    setBusy(true);
    const result = await boRequest<{ status: string; error?: string }>(`/api/backoffice/courses/${courseId}/plans/${planId}/sync-stripe`, { method: 'POST' });
    setBusy(false);
    onNotice(result.success ? `Stripe sync: ${result.data.status}${result.data.error ? ` — ${result.data.error}` : ''}` : `${L(locale, '同步失败', 'Sync failed')}: ${result.error}`);
    await onReload();
  }

  return (
    <div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '试看', 'Trial')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '试看直接引用正式学习内容；保存后立即生效，不生成版本。', 'Trial references the real learning content; saving is effective immediately and creates no version.')}</p>
          </div>
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> {L(locale, '启用试看', 'Trial enabled')}
          </label>
        </div>

        {enabled && (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>{L(locale, '试看', 'In trial')}</th>
                  <th>{L(locale, '课时', 'Lesson')}</th>
                  <th>{L(locale, '视频时长', 'Video')}</th>
                  <th>{L(locale, '视频截止点', 'Video cut-off')}</th>
                  <th>{L(locale, '文本截止学习点', 'Text cut-off LP')}</th>
                  <th>{L(locale, '状态', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.lessonId}>
                    <td><input type="checkbox" checked={row.inTrial} onChange={() => toggleRow(row.lessonId)} /></td>
                    <td>{row.index}. {row.title}</td>
                    <td>{row.videoDurationSeconds ? `${Math.floor(row.videoDurationSeconds / 60)}:${String(Math.round(row.videoDurationSeconds % 60)).padStart(2, '0')}` : '—'}</td>
                    <td>
                      <input value={fmtTime(row.videoCutoffSeconds)} disabled={!row.inTrial} placeholder="mm:ss" onChange={(event) => updateRow(row.lessonId, { videoCutoffSeconds: parseTime(event.target.value) })} style={{ width: 90, padding: 6 }} />
                    </td>
                    <td>
                      <select value={row.textCutoffLearningPointId ?? ''} disabled={!row.inTrial} onChange={(event) => updateRow(row.lessonId, { textCutoffLearningPointId: event.target.value || null })} style={{ padding: 6, maxWidth: 220 }}>
                        <option value="">—</option>
                        {row.learningPoints.filter((point) => point.language === contentLanguage).map((point) => <option key={point.id} value={point.id}>{point.code} · {point.title}</option>)}
                      </select>
                    </td>
                    <td>
                      <Chip tone={row.status === 'READY' ? 'green' : row.status === 'RE_CONFIRM' ? 'amber' : 'grey'}>{row.inTrial ? row.status : 'LOCKED'}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" style={primaryBtn} disabled={busy} onClick={() => void saveTrial()}>{L(locale, '保存试看', 'Save trial')}</button>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '价格（订阅 · USD）', 'Pricing (subscription · USD)')}</h2>
          <button type="button" style={buttonStyle} disabled={busy} onClick={addPlan}>{L(locale, '+ 添加套餐', '+ Add plan')}</button>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{L(locale, '名称', 'Name')}</th>
                <th>{L(locale, '周期（月）', 'Billing (months)')}</th>
                <th>{L(locale, '金额（美元）', 'Price (USD)')}</th>
                <th>Lookup key</th>
                <th>Stripe</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {localPlans.map((plan) => (
                <tr key={plan.id}>
                  <td><input value={plan.name} onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, name: event.target.value } : item))} style={{ padding: 6, width: '100%' }} /></td>
                  <td><input type="number" min={1} value={plan.termMonths} onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, termMonths: Number(event.target.value) } : item))} style={{ padding: 6, width: 90 }} /></td>
                  <td><input type="number" min={0} step="0.01" value={(plan.amountMinor / 100).toFixed(2)} onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, amountMinor: Math.round(Number(event.target.value) * 100) } : item))} style={{ padding: 6, width: 120 }} /></td>
                  <td style={{ fontSize: 12 }}>{plan.stripeLookupKey ?? '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {plan.syncError ? <span style={{ color: '#b42318' }}>Failed</span> : plan.lastSyncedAt ? <span style={{ color: '#1E7A3C' }}>Created</span> : '—'}
                    {plan.syncError && <div style={{ opacity: 0.75 }}>{plan.syncError}</div>}
                  </td>
                  <td>
                    {!plan.id.startsWith('new-') && <button type="button" style={{ ...buttonStyle, padding: '4px 8px' }} disabled={busy} onClick={() => void retrySync(plan.id)}>{L(locale, '重试', 'Retry')}</button>}
                  </td>
                </tr>
              ))}
              {localPlans.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无套餐。', 'No plans yet.')}</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" style={primaryBtn} disabled={busy} onClick={() => void savePlans()}>{L(locale, '保存并同步 Stripe', 'Save & sync Stripe')}</button>
        </div>
      </div>
    </div>
  );
}
