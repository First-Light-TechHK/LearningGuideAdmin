import { useEffect, useState } from 'react';

import type { CourseDetail, TrialSettings, TrialRow } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import {
  Chip,
  L,
  TimeInput,
  buttonStyle,
  card,
  languageLabel,
  primaryBtn,
  trialStatusLabel,
} from './shared';

const PLAN_TERM_OPTIONS = [1, 3, 6, 12];

function planTermLabel(locale: string, months: number): string {
  return months === 12
    ? L(locale, '每年（12个月）', 'Yearly (12 months)')
    : L(locale, `每${months}个月`, `Every ${months} months`);
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
  canManage = true,
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
  /** REQ-0236：试看与价格属商业配置，只给 Course=Full；其他角色只读。 */
  canManage?: boolean;
}) {
  const [enabled, setEnabled] = useState(trial.enabled);
  const [rows, setRows] = useState<TrialRow[]>(trial.rows);
  const [localPlans, setLocalPlans] = useState(course.plans ?? []);
  const languages = trial.learningLanguages?.length ? trial.learningLanguages : [contentLanguage];
  const [cutoffLanguage, setCutoffLanguage] = useState(contentLanguage);
  const activeCutoffLanguage = languages.includes(cutoffLanguage) ? cutoffLanguage : contentLanguage;

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

  function videoCutoffFor(row: TrialRow, language: string): number | null {
    if (language === contentLanguage) return row.videoCutoffSeconds;
    return row.videoCutoffByLanguage?.[language] ?? null;
  }

  function textCutoffFor(row: TrialRow, language: string): string | null {
    if (language === contentLanguage) return row.textCutoffLearningPointId;
    return row.textCutoffByLanguage?.[language] ?? null;
  }

  function setVideoCutoff(lessonId: string, language: string, seconds: number | null) {
    setRows((current) => current.map((row) => row.lessonId === lessonId
      ? {
          ...row,
          videoCutoffByLanguage: { ...(row.videoCutoffByLanguage ?? {}), [language]: seconds },
          ...(language === contentLanguage ? { videoCutoffSeconds: seconds } : {}),
        }
      : row));
  }

  function setTextCutoff(lessonId: string, language: string, learningPointId: string | null) {
    setRows((current) => current.map((row) => row.lessonId === lessonId
      ? {
          ...row,
          textCutoffByLanguage: { ...(row.textCutoffByLanguage ?? {}), [language]: learningPointId },
          ...(language === contentLanguage ? { textCutoffLearningPointId: learningPointId } : {}),
        }
      : row));
  }

  function cutoffMissing(row: TrialRow): boolean {
    return languages.some((language) => {
      const needsVideo = trial.learningMode !== 'TEXT_ONLY';
      const needsText = trial.learningMode !== 'VIDEO_ONLY';
      return (needsVideo && videoCutoffFor(row, language) === null) || (needsText && !textCutoffFor(row, language));
    });
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
    setLocalPlans((current) => {
      const used = new Set(current.map((plan) => plan.termMonths));
      const termMonths =
        PLAN_TERM_OPTIONS.find((months) => !used.has(months)) ?? 1;
      return [
        ...current,
        {
          id: `new-${Date.now()}`,
          name: '',
          termMonths,
          amountMinor: 1000,
          currency: 'usd',
          stripeLookupKey: null,
          stripeProductId: null,
          stripePriceId: null,
          lastSyncedAt: null,
          syncError: null,
        },
      ];
    });
  }

  // Stripe 要求同一个 lookup key 只能对应一个有效 Price；同周期套餐必然撞 key。
  const lookupKeyFor = (plan: { termMonths: number }): string =>
    `${course.code}_${plan.termMonths}m`;
  const duplicateLookupKeys = new Set(
    localPlans
      .map((plan) => lookupKeyFor(plan))
      .filter((key, index, all) => all.indexOf(key) !== index),
  );

  async function savePlans() {
    if (duplicateLookupKeys.size > 0) {
      onNotice(L(locale, `以下 Lookup key 重复，请为套餐选择不同计费周期：${[...duplicateLookupKeys].join(', ')}`, `Duplicate lookup keys — pick a different billing period per plan: ${[...duplicateLookupKeys].join(', ')}`));
      return;
    }
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
          ? `${L(locale, '套餐已保存。Stripe 同步：', 'Plans saved. Stripe sync: ')}${failed.map((entry) => entry.error ?? entry.status).join('; ')}`
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
    onNotice(result.success ? `${L(locale, 'Stripe 同步：', 'Stripe sync: ')}${result.data.status}${result.data.error ? ` — ${result.data.error}` : ''}` : `${L(locale, '同步失败', 'Sync failed')}: ${result.error}`);
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
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 12, opacity: 0.65 }}>{L(locale, '截止点语言', 'Cut-off language')}:</span>
              {languages.map((language) => (
                <button
                  key={language}
                  type="button"
                  onClick={() => setCutoffLanguage(language)}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 999,
                    border: '1px solid ' + (activeCutoffLanguage === language ? '#1D6BFF' : '#D5DCE8'),
                    background: activeCutoffLanguage === language ? '#EAF2FF' : '#fff',
                    color: activeCutoffLanguage === language ? '#1D6BFF' : '#475467',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {languageLabel(locale, language)}{language === contentLanguage ? ` · ${L(locale, '内容语言', 'content')}` : ''}
                </button>
              ))}
            </div>
            <div style={{ overflowX: 'auto' }}>
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
                      <TimeInput seconds={videoCutoffFor(row, activeCutoffLanguage)} disabled={!row.inTrial} placeholder="mm:ss" onChange={(seconds) => setVideoCutoff(row.lessonId, activeCutoffLanguage, seconds)} style={{ width: 90, padding: 6 }} />
                    </td>
                    <td>
                      <select value={textCutoffFor(row, activeCutoffLanguage) ?? ''} disabled={!row.inTrial} onChange={(event) => setTextCutoff(row.lessonId, activeCutoffLanguage, event.target.value || null)} style={{ padding: 6, maxWidth: 220 }}>
                        <option value="">—</option>
                        {row.learningPoints.filter((point) => point.language === activeCutoffLanguage).map((point) => <option key={point.id} value={point.id}>{point.code} · {point.title}</option>)}
                      </select>
                    </td>
                    <td>
                      <Chip tone={row.status === 'READY' ? 'green' : row.status === 'RE_CONFIRM' ? 'amber' : 'grey'}>{trialStatusLabel(locale, row.inTrial ? row.status : 'LOCKED')}</Chip>
                      {row.inTrial && row.status === 'RE_CONFIRM' && (
                        <div style={{ fontSize: 11, color: '#9A6B00', marginTop: 4, maxWidth: 220 }}>
                          {L(locale, '视频已更换，请检查并重新确认截止点。', 'Video changed. Check and re-confirm the cut-off.')}
                        </div>
                      )}
                      {row.inTrial && cutoffMissing(row) && (
                        <div style={{ fontSize: 11, color: '#b42318', marginTop: 4 }}>
                          {L(locale, '还有语言未设置截止点。', 'Some languages still need a cut-off.')}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {canManage && <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            style={primaryBtn}
            disabled={busy || rows.some((row) => row.inTrial && cutoffMissing(row))}
            onClick={() => void saveTrial()}
          >
            {rows.some((row) => row.inTrial && row.status === 'RE_CONFIRM')
              ? L(locale, '确认截止点并保存', 'Confirm cut-offs & save')
              : L(locale, '保存试看', 'Save trial')}
          </button>
          {rows.some((row) => row.inTrial && cutoffMissing(row)) && (
            <span style={{ fontSize: 12, color: '#b42318' }}>{L(locale, '请先为所有学习语言填写截止点。', 'Set cut-offs for every learning language first.')}</span>
          )}
        </div>}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '价格（订阅 · USD）', 'Pricing (subscription · USD)')}</h2>
          {canManage && <button type="button" style={buttonStyle} disabled={busy} onClick={addPlan}>{L(locale, '+ 添加套餐', '+ Add plan')}</button>}
        </div>
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{L(locale, '名称', 'Name')}</th>
                <th>{L(locale, '计费', 'Billing')}</th>
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
                  <td>
                    <select
                      value={String(plan.termMonths)}
                      onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, termMonths: Number(event.target.value) } : item))}
                      style={{ padding: 6, width: 130 }}
                    >
                      {(PLAN_TERM_OPTIONS.includes(plan.termMonths) ? PLAN_TERM_OPTIONS : [...PLAN_TERM_OPTIONS, plan.termMonths].sort((a, b) => a - b)).map((months) => (
                        <option key={months} value={months}>{planTermLabel(locale, months)}</option>
                      ))}
                    </select>
                  </td>
                  <td><input type="number" min={0} step="0.01" value={(plan.amountMinor / 100).toFixed(2)} onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, amountMinor: Math.round(Number(event.target.value) * 100) } : item))} style={{ padding: 6, width: 120 }} /></td>
                  <td style={{ fontSize: 12, color: duplicateLookupKeys.has(lookupKeyFor(plan)) ? '#b42318' : undefined }}>
                    {lookupKeyFor(plan)}
                    {duplicateLookupKeys.has(lookupKeyFor(plan)) && (
                      <div>{L(locale, '与其它套餐重复，Stripe 要求每个周期唯一。', 'Same as another plan; Stripe needs a unique key per period.')}</div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {plan.syncError ? <span style={{ color: '#b42318' }}>{L(locale, '同步失败', 'Failed')}</span> : plan.lastSyncedAt ? <span style={{ color: '#1E7A3C' }}>{L(locale, '已创建', 'Created')}</span> : '—'}
                    {plan.syncError && <div style={{ opacity: 0.75 }}>{plan.syncError}</div>}
                  </td>
                  <td>
                    {canManage && !plan.id.startsWith('new-') && <button type="button" style={{ ...buttonStyle, padding: '4px 8px' }} disabled={busy} onClick={() => void retrySync(plan.id)}>{L(locale, '重试', 'Retry')}</button>}
                  </td>
                </tr>
              ))}
              {localPlans.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无套餐。', 'No plans yet.')}</td></tr>}
            </tbody>
          </table>
        </div>
        {canManage && <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" style={primaryBtn} disabled={busy || duplicateLookupKeys.size > 0} onClick={() => void savePlans()}>{L(locale, '保存并同步 Stripe', 'Save & sync Stripe')}</button>
          {duplicateLookupKeys.size > 0 && (
            <span style={{ fontSize: 12, color: '#b42318' }}>{L(locale, '有套餐的计费周期相同，Lookup key 会重复，请先调整。', 'Some plans share a billing period, so their lookup keys clash — adjust them first.')}</span>
          )}
        </div>}
      </div>
    </div>
  );
}
