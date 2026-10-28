import { useCallback, useEffect, useRef, useState } from 'react'

import { App, Input, Popconfirm, Select, Table, Tag, Tooltip, type ColumnsType } from '../../components/ui'
import {
  HELPDESK_CATEGORIES,
  HELPDESK_LOCALES,
  type HelpdeskQuestion,
  type QuestionTransition,
} from '../contracts/helpdesk'
import { listQuestions, reorderQuestions, transitionQuestion } from '../lib/helpdeskApi'
import { categoryLabel, contentLocaleLabel, errorMessage } from '../lib/helpdeskFormat'
import {
  canReorder,
  moveQuestion,
  questionActions,
  type QuestionFilters,
  type QuestionStatusFilter,
} from '../lib/helpdeskQuestions'
import { longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { HdArrowIcon } from './icons'

/**
 * Common Questions Tab（Figma addendum §A，设计文档 §4A.7）。没有 Figma 画板：
 * 表格、筛选与弹窗沿用 Knowledge / AI Tutor 的 antd 组件（待视觉验收）。
 * 写操作（编辑、发布 / 下线、归档、排序）只给 FULL；VIEW 只读。
 */

const STATUS_FILTERS: QuestionStatusFilter[] = ['active', 'draft', 'published', 'archived', 'all']
const STATUS_COLOURS: Record<HelpdeskQuestion['status'], string> = {
  draft: 'default',
  published: 'green',
  archived: 'default',
}

type Props = {
  locale: Locale
  canWrite: boolean
  /** 父组件在新建 / 编辑保存后递增，用来触发刷新。 */
  refreshKey: number
  onEdit: (question: HelpdeskQuestion) => void
}

export function QuestionsView({ locale, canWrite, refreshKey, onEdit }: Props) {
  const { message } = App.useApp()
  const [filters, setFilters] = useState<QuestionFilters>({
    locale: locale === 'zh-CN' ? 'zh-CN' : 'en-GB',
    category: 'all',
    status: 'active',
    q: '',
  })
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<HelpdeskQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const request = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    const result = await listQuestions(filters)
    if (id !== request.current) return
    if (result.ok) {
      setRows(result.data.questions)
      setErrorCode(null)
    } else {
      setErrorCode(result.code)
    }
    setLoading(false)
  }, [filters])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  function onSearch(value: string) {
    setSearch(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setFilters((current) => ({ ...current, q: value })), 300)
  }

  /** 写操作失败：版本冲突先刷新列表再提示；其它错误提示一次。 */
  async function fail(code: string) {
    if (code === 'VERSION_CONFLICT' || code === 'QUESTION_NOT_FOUND') await load()
    message.error(errorMessage(locale, code))
  }

  async function transition(row: HelpdeskQuestion, action: QuestionTransition) {
    setBusyId(row.id)
    const result = await transitionQuestion(row.id, action, row.version)
    setBusyId(null)
    if (!result.ok) return fail(result.code)
    const doneKey = action === 'publish' ? 'published' : action === 'unpublish' ? 'unpublished' : 'archived'
    message.success(t(locale, `helpDesk.questions.${doneKey}`))
    await load()
  }

  async function move(index: number, delta: -1 | 1) {
    const order = moveQuestion(rows, index, delta)
    if (!order) return
    setBusyId(rows[index].id)
    const result = await reorderQuestions(order)
    setBusyId(null)
    if (!result.ok) return fail(result.code)
    message.success(t(locale, 'helpDesk.questions.reordered'))
    await load()
  }

  const sortable = canWrite && canReorder(filters)

  const columns: ColumnsType<HelpdeskQuestion> = [
    {
      title: t(locale, 'helpDesk.questions.columns.order'),
      key: 'order',
      width: sortable ? 96 : 64,
      render: (_: unknown, row, index) => (
        <span className="hdOrderCell">
          <span className="hdOrderIndex">{index + 1}</span>
          {sortable && questionActions(row, canWrite).reorder ? (
            <>
              <button
                type="button"
                className="hdIconButton"
                aria-label={t(locale, 'helpDesk.questions.actions.moveUp')}
                disabled={index === 0 || busyId !== null}
                onClick={() => void move(index, -1)}
              >
                <HdArrowIcon direction="up" />
              </button>
              <button
                type="button"
                className="hdIconButton"
                aria-label={t(locale, 'helpDesk.questions.actions.moveDown')}
                disabled={index === rows.length - 1 || busyId !== null}
                onClick={() => void move(index, 1)}
              >
                <HdArrowIcon direction="down" />
              </button>
            </>
          ) : null}
        </span>
      ),
    },
    {
      title: t(locale, 'helpDesk.questions.columns.question'),
      key: 'question',
      render: (_: unknown, row) => (
        <div className="hdQuestionCell">
          <span className="hdQuestionText">{row.question}</span>
          <span className="hdQuestionAnswer">{row.answer}</span>
          {row.keywords.length > 0 ? <span className="hdQuestionKeywords">{row.keywords.join(' · ')}</span> : null}
        </div>
      ),
    },
    {
      title: t(locale, 'helpDesk.questions.columns.locale'),
      dataIndex: 'locale',
      key: 'locale',
      width: 130,
      render: (value: string) => contentLocaleLabel(locale, value),
    },
    {
      title: t(locale, 'helpDesk.questions.columns.category'),
      dataIndex: 'category',
      key: 'category',
      width: 170,
      render: (value: string) => categoryLabel(locale, value),
    },
    {
      title: t(locale, 'helpDesk.questions.columns.status'),
      key: 'status',
      width: 150,
      render: (_: unknown, row) => (
        <span className="hdStatusCell">
          <Tag color={STATUS_COLOURS[row.status]}>{t(locale, `helpDesk.questions.status.${row.status}`)}</Tag>
          {row.featured ? <Tag color="blue">{t(locale, 'helpDesk.questions.featured')}</Tag> : null}
        </span>
      ),
    },
    {
      title: t(locale, 'helpDesk.questions.columns.stats'),
      key: 'stats',
      width: 150,
      render: (_: unknown, row) => (
        <Tooltip title={t(locale, 'helpDesk.questions.statsTitle', { ...row.stats })}>
          <span className="hdStats">
            {row.stats.shown} / {row.stats.solved} / {row.stats.declined}
          </span>
        </Tooltip>
      ),
    },
    {
      title: t(locale, 'helpDesk.questions.columns.updated'),
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 130,
      render: (value: string) => longDate(value, locale),
    },
  ]

  if (canWrite) {
    columns.push({
      title: t(locale, 'helpDesk.questions.columns.actions'),
      key: 'actions',
      width: 210,
      render: (_: unknown, row) => {
        const allowed = questionActions(row, canWrite)
        const disabled = busyId !== null
        return (
          <span className="hdRowActions">
            {allowed.edit ? (
              <button type="button" className="hdLinkButton" disabled={disabled} onClick={() => onEdit(row)}>
                {t(locale, 'helpDesk.questions.actions.edit')}
              </button>
            ) : null}
            {allowed.publish ? (
              <button
                type="button"
                className="hdLinkButton"
                disabled={disabled}
                onClick={() => void transition(row, 'publish')}
              >
                {t(
                  locale,
                  row.status === 'archived' ? 'helpDesk.questions.actions.republish' : 'helpDesk.questions.actions.publish',
                )}
              </button>
            ) : null}
            {allowed.unpublish ? (
              <button
                type="button"
                className="hdLinkButton"
                disabled={disabled}
                onClick={() => void transition(row, 'unpublish')}
              >
                {t(locale, 'helpDesk.questions.actions.unpublish')}
              </button>
            ) : null}
            {allowed.archive ? (
              <Popconfirm
                title={t(locale, 'helpDesk.questions.archiveConfirm')}
                okText={t(locale, 'helpDesk.questions.actions.archive')}
                cancelText={t(locale, 'common.cancel')}
                onConfirm={() => transition(row, 'archive')}
              >
                <button type="button" className="hdLinkButton hdLinkDanger" disabled={disabled}>
                  {t(locale, 'helpDesk.questions.actions.archive')}
                </button>
              </Popconfirm>
            ) : null}
          </span>
        )
      },
    })
  }

  const filtered = filters.category !== 'all' || filters.status !== 'active' || filters.q.trim() !== ''

  return (
    <div className="hdQuestions">
      <div className="hdQuestionFilters">
        <Select
          value={filters.locale}
          style={{ width: 170 }}
          aria-label={t(locale, 'helpDesk.questions.columns.locale')}
          onChange={(value: QuestionFilters['locale']) => setFilters((current) => ({ ...current, locale: value }))}
          options={[
            { value: 'all', label: t(locale, 'helpDesk.questions.allLocales') },
            ...HELPDESK_LOCALES.map((value) => ({ value, label: contentLocaleLabel(locale, value) })),
          ]}
        />
        <Select
          value={filters.category}
          style={{ width: 210 }}
          aria-label={t(locale, 'helpDesk.questions.columns.category')}
          onChange={(value: QuestionFilters['category']) => setFilters((current) => ({ ...current, category: value }))}
          options={[
            { value: 'all', label: t(locale, 'helpDesk.questions.allCategories') },
            ...HELPDESK_CATEGORIES.map((value) => ({ value, label: categoryLabel(locale, value) })),
          ]}
        />
        <Select
          value={filters.status}
          style={{ width: 200 }}
          aria-label={t(locale, 'helpDesk.questions.columns.status')}
          onChange={(value: QuestionStatusFilter) => setFilters((current) => ({ ...current, status: value }))}
          options={STATUS_FILTERS.map((value) => ({
            value,
            label: t(locale, `helpDesk.questions.statusFilter.${value}`),
          }))}
        />
        <Input.Search
          allowClear
          value={search}
          maxLength={200}
          placeholder={t(locale, 'helpDesk.questions.search')}
          style={{ width: 240 }}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      {canWrite && !canReorder(filters) ? (
        <p className="hdFormHint hdReorderHint">{t(locale, 'helpDesk.questions.reorderHint')}</p>
      ) : null}
      {errorCode ? (
        <div className="alert alertError" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}
      <div className="hdQuestionTable">
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: filtered ? t(locale, 'helpDesk.questions.emptyFiltered') : t(locale, 'helpDesk.questions.empty'),
          }}
        />
      </div>
    </div>
  )
}
