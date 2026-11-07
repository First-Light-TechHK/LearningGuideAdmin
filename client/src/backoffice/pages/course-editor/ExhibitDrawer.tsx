import { useState } from 'react';

import type { Exhibit, Lesson } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { formatBytes, uploadFileWithProgress } from '../../lib/upload';
import { useMediaLimits } from '../../lib/mediaLimits';
import { UploadProgress } from '../../components/UploadProgress';
import { Chip, Field, Modal } from './shared';
import { L, buttonStyle, dangerBtn, exhibitTypeLabel, inputStyle, languageLabel, primaryBtn } from './shared-utils';

type Asset = { id: string; kind?: string; originalName?: string; size?: number; mimeType?: string };

export function ExhibitDrawer({
  locale,
  courseId,
  lesson,
  exhibit,
  learningLanguages,
  busy,
  setBusy,
  onClose,
  onSaved,
  onNotice,
}: {
  locale: string;
  courseId: string;
  lesson: Lesson;
  exhibit?: Exhibit;
  learningLanguages: string[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [type, setType] = useState(exhibit?.type ?? 'IMAGE');
  const [media, setMedia] = useState<Asset | null>(exhibit?.media ?? null);
  const [thumbnail, setThumbnail] = useState<Asset | null>(exhibit?.thumbnail ?? null);
  const [source, setSource] = useState(exhibit?.sourceText ?? '');
  const [localized, setLocalized] = useState<Record<string, { title: string; description: string }>>(() => {
    const base: Record<string, { title: string; description: string }> = {};
    for (const language of learningLanguages) {
      base[language] = {
        title: exhibit?.localized?.[language]?.title ?? '',
        description: exhibit?.localized?.[language]?.description ?? '',
      };
    }
    return base;
  });
  const [previewLanguage, setPreviewLanguage] = useState(learningLanguages[0] ?? 'en-GB');
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const mediaLimits = useMediaLimits();

  function kindToType(kind?: string) {
    if (kind === 'VIDEO') return 'VIDEO';
    if (kind === 'MODEL3D') return 'MODEL3D';
    return 'IMAGE';
  }

  async function upload(file: File, thumbnailOnly = false) {
    const limitBytes = thumbnailOnly
      ? mediaLimits?.imageBytes
      : type === 'VIDEO'
        ? mediaLimits?.videoBytes
        : type === 'MODEL3D'
          ? mediaLimits?.modelBytes
          : mediaLimits?.imageBytes;
    if (limitBytes && file.size > limitBytes) {
      setError(
        L(
          locale,
          `文件超过单文件上限 ${formatBytes(limitBytes)}（当前 ${formatBytes(file.size)}）。`,
          `File exceeds the ${formatBytes(limitBytes)} per-file limit (this file is ${formatBytes(file.size)}).`,
        ),
      );
      return;
    }
    setBusy(true);
    setError('');
    setUploadPct(0);
    const uploaded = await uploadFileWithProgress<Asset>(
      `/api/backoffice/courses/${courseId}/media`,
      file,
      setUploadPct,
    );
    setUploadPct(null);
    setBusy(false);
    if (!uploaded.success) {
      setError(uploaded.errorMessage ?? L(locale, '文件上传失败。', 'File upload failed.'));
      return;
    }
    if (thumbnailOnly) setThumbnail(uploaded.data);
    else {
      setMedia(uploaded.data);
      setType(kindToType(uploaded.data.kind));
    }
  }

  async function save() {
    const missing = learningLanguages.find((language) => !localized[language]?.title?.trim() || !localized[language]?.description?.trim());
    if (!media) {
      setError(L(locale, '请上传文件。', 'Upload a file.'));
      return;
    }
    if (missing) {
      setError(L(locale, `请填写 ${missing} 的标题和描述。`, `Complete the title and description for ${missing}.`));
      return;
    }
    setBusy(true);
    setError('');
    const payload = {
      type,
      mediaAssetId: media.id,
      thumbnailAssetId: thumbnail?.id ?? null,
      sourceText: source.trim() || null,
      localized,
    };
    const result = exhibit
      ? await boRequest(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}/exhibits/${exhibit.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      : await boRequest(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}/exhibits`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
    setBusy(false);
    if (result.success) {
      onNotice(exhibit ? L(locale, '展品已更新。', 'Exhibit updated.') : L(locale, '展品已添加。', 'Exhibit added.'));
      await onSaved();
      onClose();
    } else {
      setError(result.message ?? L(locale, '保存展品失败。', 'Could not save the exhibit.'));
    }
  }

  async function remove() {
    if (!exhibit) return;
    if (!window.confirm(L(locale, '删除该展品？被引用的展品不能删除。', 'Delete this exhibit? Referenced exhibits cannot be deleted.'))) return;
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}/exhibits/${exhibit.id}`, { method: 'DELETE' });
    setBusy(false);
    if (result.success) {
      onNotice(L(locale, '展品已删除。', 'Exhibit deleted.'));
      await onSaved();
      onClose();
    } else {
      setError(result.message ?? L(locale, '删除失败。', 'Delete failed.'));
    }
  }

  const previewText = localized[previewLanguage] ?? localized[learningLanguages[0]] ?? { title: '', description: '' };

  return (
    <>
      <Modal title={exhibit ? L(locale, '编辑展品', 'Edit exhibit') : L(locale, '添加展品', 'Add exhibit')} onClose={onClose} width={680}>
        <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.65 }}>{L(locale, '课时', 'Lesson')} {lesson.sortOrder} · {lesson.localizations[0]?.title ?? lesson.code}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={L(locale, '展品 ID', 'Exhibit ID')}>
            <input readOnly value={exhibit?.code ?? L(locale, '保存后生成', 'Generated on save')} style={{ ...inputStyle, background: '#F5F7FA' }} />
          </Field>
          <Field label={L(locale, '媒体类型 *', 'Media type *')}>
            <select value={type} onChange={(event) => setType(event.target.value)} style={inputStyle}>
              <option value="IMAGE">{exhibitTypeLabel(locale, 'IMAGE')}</option>
              <option value="VIDEO">{exhibitTypeLabel(locale, 'VIDEO')}</option>
              <option value="MODEL3D">{exhibitTypeLabel(locale, 'MODEL3D')}</option>
            </select>
          </Field>
        </div>

        <Field
          label={L(locale, '文件 *', 'File *')}
          hint={
            type === 'VIDEO'
              ? L(locale, `MP4 (H.264)，最高 1080p，单文件最大 ${mediaLimits ? formatBytes(mediaLimits.videoBytes) : '500 MB'}`, `MP4 (H.264), up to 1080p, max ${mediaLimits ? formatBytes(mediaLimits.videoBytes) : '500 MB'}`)
              : type === 'MODEL3D'
                ? L(locale, `GLB，单文件最大 ${mediaLimits ? formatBytes(mediaLimits.modelBytes) : '25 MB'}`, `GLB, max ${mediaLimits ? formatBytes(mediaLimits.modelBytes) : '25 MB'}`)
                : L(
                    locale,
                    `JPG、PNG 或 WebP · 长边 ≥ 2000 px · 单文件最大 ${mediaLimits ? formatBytes(mediaLimits.imageBytes) : '20 MB'}`,
                    `JPG, PNG or WebP · long edge ≥ 2000 px · max ${mediaLimits ? formatBytes(mediaLimits.imageBytes) : '20 MB'}`,
                  )
          }
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, fontSize: 13 }}>{media ? `${media.originalName ?? media.id}${media.size ? ` · ${(media.size / 1024 / 1024).toFixed(1)} MB` : ''}` : L(locale, '尚未上传', 'No file yet')}</span>
            <label style={{ ...buttonStyle, cursor: busy ? 'not-allowed' : 'pointer' }}>
              {media ? L(locale, '替换', 'Replace') : L(locale, '上传', 'Upload')}
              <input type="file" disabled={busy} style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} />
            </label>
          </div>
        </Field>

        <Field label={L(locale, '缩略图（正方形）*', 'Thumbnail (square) *')} hint={L(locale, '视频和 3D 必须单独上传；图片可使用原图。', 'Required for video and 3D; an image can use its own media file.')}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {thumbnail ? <img src={`/api/backoffice/courses/${courseId}/media/${thumbnail.id}`} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid #E8EDF5' }} /> : null}
            <span style={{ flex: 1, fontSize: 13 }}>{thumbnail?.originalName ?? L(locale, '未上传缩略图', 'No thumbnail')}</span>
            <label style={{ ...buttonStyle, cursor: busy ? 'not-allowed' : 'pointer' }}>
              {L(locale, '上传缩略图', 'Upload thumbnail')}
              <input type="file" accept="image/*" disabled={busy} style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file, true); event.currentTarget.value = ''; }} />
            </label>
          </div>
        </Field>

        {learningLanguages.map((language) => (
          <div key={language} style={{ borderTop: '1px solid #EEF1F6', marginTop: 12, paddingTop: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8 }}>{languageLabel(locale, language)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label={L(locale, '标题 *', 'Title *')}>
                <input value={localized[language]?.title ?? ''} onChange={(event) => setLocalized((current) => ({ ...current, [language]: { ...current[language], title: event.target.value } }))} style={inputStyle} />
              </Field>
              <Field label={L(locale, '描述 *', 'Description *')}>
                <input value={localized[language]?.description ?? ''} onChange={(event) => setLocalized((current) => ({ ...current, [language]: { ...current[language], description: event.target.value } }))} style={inputStyle} />
              </Field>
            </div>
          </div>
        ))}

        <Field label={L(locale, '来源', 'Source')}>
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder={L(locale, '选填，例如 Wikimedia Commons', 'Optional, e.g. Wikimedia Commons')} style={inputStyle} />
        </Field>

        {uploadPct !== null && (
          <UploadProgress
            tone="active"
            title={L(locale, '正在上传文件…', 'Uploading file…')}
            pct={uploadPct}
          />
        )}
        {error && <p style={{ color: '#b42318', background: '#FDECEC', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <button type="button" style={primaryBtn} disabled={busy} onClick={() => void save()}>{L(locale, '保存展品', 'Save exhibit')}</button>
          <button type="button" style={buttonStyle} disabled={!media} onClick={() => setPreview(true)}>{L(locale, '学员视角预览', 'Preview as learner')}</button>
          {exhibit && <button type="button" style={dangerBtn} disabled={busy} onClick={() => void remove()}>{L(locale, '删除展品', 'Delete exhibit')}</button>}
          <button type="button" style={buttonStyle} onClick={onClose}>{L(locale, '取消', 'Cancel')}</button>
        </div>
      </Modal>

      {preview && media && (
        <Modal title={previewText.title || L(locale, '展品预览', 'Exhibit preview')} onClose={() => setPreview(false)} width={760}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <Chip tone="blue">{L(locale, '后台预览 · 学员不可见', 'Back office preview · not visible to learners')}</Chip>
            {learningLanguages.map((language) => (
              <button key={language} type="button" style={{ ...buttonStyle, borderColor: previewLanguage === language ? '#2B58C8' : '#d9e0ea' }} onClick={() => setPreviewLanguage(language)}>
                {languageLabel(locale, language)}
              </button>
            ))}
          </div>
          <div style={{ background: '#0F172A', borderRadius: 10, minHeight: 320, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
            {type === 'VIDEO' ? (
              <video src={`/api/backoffice/courses/${courseId}/media/${media.id}`} controls style={{ maxWidth: '100%', maxHeight: 480 }} />
            ) : type === 'IMAGE' ? (
              <img src={`/api/backoffice/courses/${courseId}/media/${media.id}`} alt="" style={{ maxWidth: '100%', maxHeight: 480, objectFit: 'contain' }} />
            ) : (
              <div style={{ color: '#fff', padding: 24, textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{media.originalName ?? '3D model'}</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>{L(locale, '3D 预览由前台查看器提供。', 'The learner viewer renders 3D models.')}</div>
              </div>
            )}
          </div>
          <p style={{ marginTop: 12, fontSize: 13 }}>{previewText.description}</p>
          {source && <p style={{ fontSize: 12, opacity: 0.65 }}>{L(locale, '来源', 'Source')}: {source}</p>}
        </Modal>
      )}
    </>
  );
}
