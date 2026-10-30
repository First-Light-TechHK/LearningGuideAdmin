import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { App } from '../../components/ui'
import '../helpdesk.css'
import type { HelpdeskFaq } from '../contracts/helpdesk'
import { CandidateDrawer, type Compose } from '../helpdesk/CandidateDrawer'
import { CandidatesView } from '../helpdesk/CandidatesView'
import { EnquiriesView } from '../helpdesk/EnquiriesView'
import { FaqDrawer } from '../helpdesk/FaqDrawer'
import { FaqPreview } from '../helpdesk/FaqPreview'
import { FaqReleasesDrawer } from '../helpdesk/FaqReleasesDrawer'
import { FaqTreeDrawer } from '../helpdesk/FaqTreeDrawer'
import { FaqsView } from '../helpdesk/FaqsView'
import { FlywheelDataView } from '../helpdesk/FlywheelDataView'
import { TraceDrawer } from '../helpdesk/TraceDrawer'
import { acceptCandidate, newIdempotencyKey } from '../lib/helpdeskApi'
import { afterFaqSave, type FaqDrawerResult } from '../lib/helpdeskFaqs'
import { errorMessage } from '../lib/helpdeskFormat'
import { helpDeskPageControls } from '../lib/helpdeskView'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { useWorkspaceAccess } from '../lib/workspaceAccess'

/**
 * Help Desk（Tickets v2，Figma 1324:2 / 1379:2 / 1379:299）：页头 +「+ Add FAQ」（两个 Tab 都有）+ 两个 Tab。
 * - Enquiries（缺省）：三栏，/help-desk/:ticketId 选中一条工单，中栏是这个学员的时间线
 * - FAQs（?tab=faqs；旧链接 ?tab=questions 也到这里）：FAQ 表格，抽屉新增 / 编辑，Preview
 * 抽屉盖在 Tab 下方的内容区上（.hdContent）。抽屉或 Preview 打开时，页头、Tab 和后面的列表都 inert
 *（点不到、Tab 不进去），「+ Add FAQ」与切 Tab 也不会替换掉正在编辑的草稿。写操作只给 helpDesk = FULL；VIEW 能看能预览，
 * 没有任何写控件（服务端同样拒绝）。Enquiries 里 AI 块的「查看链路」抽屉（只读）也在这一层打开。
 * v5 问题树（graph design §5，待视觉验收）：FAQs Tab 的每一行「问题树」打开大纲 + 对话预览抽屉（只读）；
 * 页头「版本发布」打开发布新版本 / 版本历史抽屉（所有角色能看，写操作只给 FULL）。
 * v5 Part G（待视觉验收）：「FAQ 候选」Tab（?tab=candidates，详情 ?candidate=<id>）与「HelpDesk 数据」Tab
 *（?tab=data）。候选的「新 FAQ / 加成追问」在这一层打开预填的 FAQ 抽屉，保存成功后用新 FAQ 的 id 接受候选。
 */

type TabKey = 'enquiries' | 'faqs' | 'candidates' | 'data'
const TABS: readonly TabKey[] = ['enquiries', 'faqs', 'candidates', 'data']
type Editing = { faq: HelpdeskFaq | null; compose?: Compose } | null

function tabOf(param: string | null, ticketId: string | undefined): TabKey {
  if (ticketId) return 'enquiries'
  if (param === 'faqs' || param === 'questions') return 'faqs'
  if (param === 'candidates' || param === 'data') return param
  return 'enquiries'
}

export default function HelpDeskPage() {
  const locale = useLocale()
  const access = useWorkspaceAccess()
  const canWrite = access.canCreate
  const controls = helpDeskPageControls(canWrite)
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { ticketId } = useParams<{ ticketId?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab = tabOf(tabParam, ticketId)
  const [editing, setEditing] = useState<Editing>(null)
  const [previewing, setPreviewing] = useState<HelpdeskFaq | null>(null)
  const [faqsVersion, setFaqsVersion] = useState(0)
  /** 「查看链路」打开的 run（AI 块 id）；只读，VIEW 也能开。 */
  const [tracing, setTracing] = useState<string | null>(null)
  const [treeOf, setTreeOf] = useState<HelpdeskFaq | null>(null)
  const [releasesOpen, setReleasesOpen] = useState(false)
  const [candidatesVersion, setCandidatesVersion] = useState(0)
  const candidateId = tab === 'candidates' ? searchParams.get('candidate') : null
  const drawerOpen = Boolean(editing && controls.faqDrawer)
  const modal =
    drawerOpen || previewing !== null || tracing !== null || treeOf !== null || releasesOpen || candidateId !== null

  // v1 的 Common Questions 链接（?tab=questions）换成 ?tab=faqs，其它参数保留
  useEffect(() => {
    if (tabParam !== 'questions' || ticketId) return
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set('tab', 'faqs')
        return next
      },
      { replace: true },
    )
  }, [tabParam, ticketId, setSearchParams])

  function openTab(next: TabKey) {
    if (next === tab || modal) return
    navigate(next === 'enquiries' ? `/${locale}/help-desk` : `/${locale}/help-desk?tab=${next}`)
  }

  /** 候选详情在地址栏（?candidate=），刷新 / 分享不丢；关掉时去掉。 */
  function openCandidate(id: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (id) next.set('candidate', id)
        else next.delete('candidate')
        return next
      },
      { replace: id === null },
    )
  }

  /** 「新 FAQ / 加成追问」：关掉候选详情，打开预填的 FAQ 抽屉。 */
  function compose(next: Compose) {
    openCandidate(null)
    setEditing({ faq: null, compose: next })
  }

  /** 从候选建的 FAQ 保存成功：用它的 id 接受候选（选中的例句成问法，追问另外建边）。 */
  async function acceptComposed(next: Compose, faqId: string) {
    const result = await acceptCandidate(
      next.candidate.id,
      {
        as: next.as,
        faqId,
        ...(next.as === 'follow_up' ? { parentId: next.parentId } : {}),
        phrasings: next.phrasings,
        version: next.version,
      },
      newIdempotencyKey(),
    )
    setCandidatesVersion((value) => value + 1)
    if (result.ok) message.success(t(locale, 'helpDesk.candidates.faqAccepted'))
    else message.error(t(locale, 'helpDesk.candidates.faqNotAccepted', { error: errorMessage(locale, result.code) }))
  }

  function onDrawerDone(result: FaqDrawerResult, saved?: HelpdeskFaq) {
    // Enquiries Tab 上看不到列表，靠提示告诉员工结果
    const next = afterFaqSave(result)
    const composed = editing?.compose
    if (next.refresh) setFaqsVersion((value) => value + 1)
    if (next.close) setEditing(null)
    if (composed && result === 'saved' && saved) void acceptComposed(composed, saved.id)
    else if (next.toast === 'saved') message.success(t(locale, 'helpDesk.faqs.saved'))
    else if (next.toast === 'deleted') message.success(t(locale, 'helpDesk.faqs.deleted'))
    else message.error(errorMessage(locale, 'FAQ_NOT_FOUND'))
  }

  return (
    <section className="card cardGrow hdPage">
      <header className="hdHeader" inert={modal}>
        <div className="hdTitleBlock">
          <h1 className="cardTitle">{t(locale, 'helpDesk.title')}</h1>
          <p className="hdSubtitle">{t(locale, 'helpDesk.subtitle')}</p>
        </div>
        <div className="hdHeaderActions">
          {tab === 'faqs' ? (
            <button type="button" className="hdDrawerButton hdReleasesButton" onClick={() => !modal && setReleasesOpen(true)}>
              {t(locale, 'helpDesk.releases.button')}
            </button>
          ) : null}
          {controls.addFaq ? (
            <button type="button" className="hdPrimaryButton" onClick={() => !modal && setEditing({ faq: null })}>
              + {t(locale, 'helpDesk.addFaq')}
            </button>
          ) : null}
        </div>
      </header>

      <div className="hdTabs" role="tablist" aria-label={t(locale, 'helpDesk.title')} inert={modal}>
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={key === tab}
            className={`hdTab${key === tab ? ' hdTabActive' : ''}`}
            onClick={() => openTab(key)}
          >
            {t(locale, `helpDesk.tabs.${key}`)}
          </button>
        ))}
      </div>

      {access.readOnly ? (
        <div className="hdReadOnly" inert={modal}>
          {t(locale, 'helpDesk.readOnly')}
        </div>
      ) : null}

      <div className="hdContent">
        <div className="hdContentBody" inert={modal}>
          {tab === 'enquiries' ? (
            <EnquiriesView
              locale={locale}
              ticketId={ticketId ?? null}
              canWrite={canWrite}
              onTrace={(runId) => !modal && setTracing(runId)}
            />
          ) : tab === 'candidates' ? (
            <CandidatesView
              locale={locale}
              canWrite={canWrite}
              refreshKey={candidatesVersion}
              onOpen={(id) => !modal && openCandidate(id)}
              onRefresh={() => setCandidatesVersion((value) => value + 1)}
            />
          ) : tab === 'data' ? (
            <FlywheelDataView
              locale={locale}
              onOpenCandidate={(id) => navigate(`/${locale}/help-desk?tab=candidates&status=all&candidate=${encodeURIComponent(id)}`)}
            />
          ) : (
            <FaqsView
              locale={locale}
              canWrite={canWrite}
              refreshKey={faqsVersion}
              onEdit={(faq) => setEditing({ faq })}
              onPreview={setPreviewing}
              onTree={setTreeOf}
            />
          )}
        </div>

        {editing && drawerOpen ? (
          <FaqDrawer
            key={editing.faq?.id ?? (editing.compose ? `candidate-${editing.compose.candidate.id}` : 'new')}
            locale={locale}
            faq={editing.faq}
            initial={editing.compose?.initial}
            fromCandidate={editing.compose?.candidate.topic ?? null}
            draftSources={editing.compose?.draftSources}
            onClose={() => setEditing(null)}
            onDone={onDrawerDone}
          />
        ) : null}

        {candidateId && !drawerOpen ? (
          <CandidateDrawer
            key={candidateId}
            locale={locale}
            candidateId={candidateId}
            canWrite={canWrite}
            onClose={() => openCandidate(null)}
            onChanged={() => setCandidatesVersion((value) => value + 1)}
            onCompose={compose}
          />
        ) : null}

        {tracing ? <TraceDrawer key={tracing} locale={locale} runId={tracing} onClose={() => setTracing(null)} /> : null}

        {treeOf ? <FaqTreeDrawer key={treeOf.id} locale={locale} faq={treeOf} onClose={() => setTreeOf(null)} /> : null}

        {releasesOpen ? (
          <FaqReleasesDrawer
            locale={locale}
            canWrite={canWrite}
            onClose={() => {
              setReleasesOpen(false)
              setFaqsVersion((value) => value + 1)
            }}
          />
        ) : null}
      </div>

      {previewing ? <FaqPreview locale={locale} faq={previewing} onClose={() => setPreviewing(null)} /> : null}
    </section>
  )
}
