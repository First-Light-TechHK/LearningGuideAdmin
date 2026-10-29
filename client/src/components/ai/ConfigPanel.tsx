import { useState } from 'react'
import { App, Button, Card, Divider, Input, Popconfirm, Segmented, Select, Space, Switch, Typography } from '../ui'
import { useAiStore } from '../../stores/aiStore'
import { useUnsavedGuard } from './useUnsavedGuard'
import { useAiText } from './i18n'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'

const { Text } = Typography

/** 区块样式：flex 纵向，label 固定、输入区填满剩余高度 */
const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}
const labelStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xl,
  fontWeight: tokens.fontWeight.medium,
  marginBottom: tokens.spacing.xs,
  flexShrink: 0,
}
const extraStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  color: tokens.color.text.secondary,
  marginTop: tokens.spacing.xs,
  flexShrink: 0,
}

/**
 * AI Tutor 左侧配置面板（§4.2）：
 * System Prompt / Welcome Message / LLM Model 按比例分布，底部 Reset + Save 固定。
 * 卡片标题行左侧显示当前 Course 名（2026-10-20 与顶部栏「AI Tutor」对调）。
 * Change Course 位于卡片标题行右侧（2026-10-20 由页面顶部栏移入，与 Course 名同一行）。
 * Online 开关紧贴 Course 名右侧（2026-10-20 新增，§4.2.6）：控制该配置是否对用户侧开放，切换即时生效。
 * Change Course 下拉面板底部追加「管理所有 online」链接（2026-10-20，§4.2.6），点击打开管理弹窗。
 * 底部操作栏无分隔线：Reset 为蓝色下划线文字链接（左），Unsaved changes + Save 靠右（2026-10-20）。
 * 注：API Key 统一使用服务端全局 OPENROUTER_API_KEY，课程级覆盖已下线（2026-10-15）。
 */
export function ConfigPanel() {
  const { message } = App.useApp()
  /** PRD §3.2/§3.3：配置保存/重置是 EDIT，Online 上下线是 PUBLISH；View 角色只读 */
  const access = useWorkspaceAccess()
  const models = useAiStore((s) => s.models)
  const courses = useAiStore((s) => s.courses)
  const selectedCourseId = useAiStore((s) => s.selectedCourseId)
  const config = useAiStore((s) => s.config)
  const editMode = useAiStore((s) => s.editMode)
  const setEditMode = useAiStore((s) => s.setEditMode)
  const selectCourse = useAiStore((s) => s.selectCourse)
  const form = useAiStore((s) => s.form)
  const saving = useAiStore((s) => s.saving)
  const isDirty = useAiStore((s) => s.isDirty)
  const patchForm = useAiStore((s) => s.patchForm)
  const save = useAiStore((s) => s.save)
  const reset = useAiStore((s) => s.reset)
  const setOnline = useAiStore((s) => s.setOnline)
  const openTutorManager = useAiStore((s) => s.openTutorManager)
  const streaming = useAiStore((s) => s.streaming)
  const { text, modeLabel } = useAiText()
  /** 未保存改动守卫（§4.3.6）：切换课程前弹「保存 / 取消」 */
  const guard = useUnsavedGuard()

  /** Change Course 下拉受控开关：点击底部「管理所有 online」后需强制收起面板 */
  const [courseOpen, setCourseOpen] = useState(false)

  /** 卡片标题行左侧显示当前 Course 名（2026-10-20 与顶部栏「AI Tutor」对调） */
  const courseName = courses.find((c) => c.id === selectedCourseId)?.title ?? '—'

  const dirty = isDirty()

  const onSave = async () => {
    // save() 内部吞异常并返回布尔（§4.3.6 供 guard 判断）
    const ok = await save()
    if (ok) {
      message.success(text('saved'))
    } else {
      message.error(useAiStore.getState().error ?? text('saveFailed'))
    }
  }

  /** Change Course：切换前先过未保存提醒（§4.3.6），保存成功才切换，取消则丢弃改动后切换 */
  const onChangeCourse = async (v: string) => {
    if (!(await guard())) return
    await selectCourse(v)
  }

  /** 切换编辑分段项（MAIN / Lecture / Socratic / Assessment）前先过未保存提醒 */
  const onEditModeChange = async (v: string) => {
    if (!(await guard())) return
    setEditMode(v as 'MAIN' | 'LECTURE' | 'SOCRATIC' | 'ASSESSMENT')
  }

  /** Reset 只改编辑区，Save 后才生效（REQ-0147，QA 2026-10-27 A4） */
  const onReset = () => {
    reset()
    message.info(text('resetDone'))
  }

  const onOnlineChange = async (checked: boolean) => {
    // 2026-10-29：打开 Online 需先满足 Portal 同步 + 有上线版本两个前提；
    // 不满足时拦截并弹 warning，开关不会真的打开（Switch 会弹回）。
    if (checked) {
      if (!config?.externalId) {
        message.warning(text('onlineNotSynced'))
        return
      }
      if (!config?.hasLiveRelease) {
        message.warning(text('onlineNoLive'))
        return
      }
    }
    try {
      await setOnline(checked)
      message.success(checked ? text('onlineOn') : text('onlineOff'))
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const onManageOnline = () => {
    setCourseOpen(false)
    void openTutorManager()
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing.md,
      }}
    >
      <Card
        title={
          // 标题行：左侧当前 Course 名 + 紧贴的 Online 开关、右侧 Change Course 下拉（同一行，2026-10-20）
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing.sm,
              width: '100%',
            }}
          >
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={courseName}
            >
              {courseName}
            </span>
            {/* Online 开关：开关左侧为 "Online" 文案，紧贴标题右侧（§4.2.6） */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: tokens.spacing.xs,
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: tokens.fontSize.md, color: tokens.color.text.secondary }}>
                {text('online')}
              </span>
              <Switch
                size="small"
                checked={config?.online ?? false}
                disabled={!access.canPublish || !selectedCourseId}
                onChange={(v) => void onOnlineChange(v)}
              />
            </span>
            <Select
              value={selectedCourseId ?? undefined}
              placeholder={text('changeCourse')}
              size="small"
              open={courseOpen}
              // 流式回答进行中不允许切换课程（QA 2026-10-27 A13）
              disabled={streaming}
              onOpenChange={setCourseOpen}
              style={{ minWidth: 150, flexShrink: 0, marginLeft: 'auto' }}
              onChange={(v) => void onChangeCourse(v)}
              options={courses.map((c) => ({ value: c.id, label: c.title }))}
              // 下拉面板底部追加「管理所有 online」链接（§4.2.6）；View/Edit 角色不显示
              popupRender={(menu) => (
                <>
                  {menu}
                  {access.canPublish && (
                    <>
                      <Divider style={{ margin: `${tokens.spacing.xs}px 0` }} />
                      <div style={{ padding: `0 ${tokens.spacing.sm}px ${tokens.spacing.xs}px` }}>
                        <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={onManageOnline}>
                          <span style={{ textDecoration: 'underline' }}>{text('manageOnline')}</span>
                        </Button>
                      </div>
                    </>
                  )}
                </>
              )}
            />
          </div>
        }
        size="small"
        // 卡片占满操作栏上方剩余高度：下边界止于 LLM Model 功能区下方，不再包裹操作栏（2026-10-20）
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        styles={{
          body: {
            flex: 1,
            minHeight: 0,
            padding: tokens.spacing.md,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        }}
      >
        {/* 分段控件（2026-10-29 新增 MAIN 主提示词项，置于最前）：蓝色滑块样式与对话区对齐 */}
        <div style={{ marginBottom: tokens.spacing.md, flexShrink: 0 }}>
          <Segmented
            block
            className="ai-segmented"
            value={editMode}
            onChange={(v) => void onEditModeChange(v as string)}
            options={(['MAIN', 'LECTURE', 'SOCRATIC', 'ASSESSMENT'] as const).map((m) => ({
              label: modeLabel(m),
              value: m,
            }))}
          />
        </div>

        {/* System Prompt：占剩余空间的 70%，超出文本框可滚动 */}
        <div style={{ ...sectionStyle, flex: '7 1 0', marginBottom: tokens.spacing.md }}>
          <div style={labelStyle}>{text('systemPrompt')}</div>
          <Input.TextArea
            value={form.systemPrompt}
            readOnly={!access.canEdit}
            onChange={(e) => patchForm({ systemPrompt: e.target.value })}
            style={{
              fontFamily: 'monospace',
              flex: 1,
              minHeight: 0,
              resize: 'none',
            }}
          />
          <div style={extraStyle}>{text('systemPromptHint', { mode: modeLabel(editMode) })}</div>
        </div>

        {/* Welcome Message：占剩余空间的 30%，超出可滚动 */}
        <div style={{ ...sectionStyle, flex: '3 1 0', marginBottom: tokens.spacing.md }}>
          <div style={labelStyle}>{text('welcomeMessage')}</div>
          <Input.TextArea
            value={form.welcomeMsg}
            readOnly={!access.canEdit}
            onChange={(e) => patchForm({ welcomeMsg: e.target.value })}
            style={{ flex: 1, minHeight: 0, resize: 'none' }}
          />
        </div>

        {/* LLM Model：自然高度，不参与比例分配 */}
        <div style={{ ...sectionStyle, flex: '0 0 auto' }}>
          <div style={labelStyle}>{text('llmModel')}</div>
          <Select
            value={form.llmModel || undefined}
            placeholder={text('selectModel')}
            disabled={!access.canEdit}
            onChange={(v) => patchForm({ llmModel: v })}
            options={models.map((m) => ({ value: m, label: m }))}
            style={{ width: '100%' }}
          />
        </div>
      </Card>

      {/* 底部操作栏（2026-10-20 脱离卡片，位于卡片下方）：Reset 蓝色下划线文字链接（左）；Unsaved changes + Save 靠右（§4.2.5）。View 角色只读，不显示 */}
      {access.canEdit && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
            padding: `0 ${tokens.spacing.xs}px`,
          }}
        >
          <Popconfirm
            title={text('resetTitle')}
            description={text('resetDescription', { mode: modeLabel(editMode) })}
            okText={text('resetConfirm')}
            cancelText={text('unsavedStay')}
            onConfirm={onReset}
            overlayInnerStyle={{ width: 416 }}
          >
            <Button type="link" style={{ padding: 0, height: 'auto' }}>
              <span style={{ textDecoration: 'underline' }}>{text('reset')}</span>
            </Button>
          </Popconfirm>
          <Space size={tokens.spacing.lg}>
            {dirty && <Text type="warning">{text('unsaved')}</Text>}
            <Button type="primary" loading={saving} onClick={() => void onSave()}>
              {text('save')}
            </Button>
          </Space>
        </div>
      )}
    </div>
  )
}
