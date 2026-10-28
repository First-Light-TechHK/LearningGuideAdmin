import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { App } from '../../components/ui'
import '../helpdesk.css'
import type { HelpdeskQuestion } from '../contracts/helpdesk'
import { EnquiriesView } from '../helpdesk/EnquiriesView'
import { QuestionModal } from '../helpdesk/QuestionModal'
import { QuestionsView } from '../helpdesk/QuestionsView'
import { errorMessage } from '../lib/helpdeskFormat'
import { afterQuestionSave } from '../lib/helpdeskQuestions'
import { helpDeskPageControls } from '../lib/helpdeskView'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { useWorkspaceAccess } from '../lib/workspaceAccess'

/**
 * Help Desk（Figma 1324:2，设计文档 §4A.3 / §4A.7）：页头 +「+ Add Question」+ 两个 Tab。
 * - Enquiries（缺省）：三栏，/help-desk/:ticketId 选中一条咨询
 * - Common Questions（?tab=questions）：问答库表格
 * 写操作只给 helpDesk = FULL；VIEW 看得到全部内容，但没有任何写控件（服务端同样拒绝）。
 */

type TabKey = 'enquiries' | 'questions'
type Editing = { question: HelpdeskQuestion | null } | null

export default function HelpDeskPage() {
  const locale = useLocale()
  const access = useWorkspaceAccess()
  const canWrite = access.canCreate
  const controls = helpDeskPageControls(canWrite)
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { ticketId } = useParams<{ ticketId?: string }>()
  const [searchParams] = useSearchParams()
  const tab: TabKey = searchParams.get('tab') === 'questions' && !ticketId ? 'questions' : 'enquiries'
  const [editing, setEditing] = useState<Editing>(null)
  const [questionsVersion, setQuestionsVersion] = useState(0)

  function openTab(next: TabKey) {
    if (next === tab) return
    navigate(next === 'questions' ? `/${locale}/help-desk?tab=questions` : `/${locale}/help-desk`)
  }

  return (
    <section className="card cardGrow hdPage">
      <header className="hdHeader">
        <div className="hdTitleBlock">
          <h1 className="cardTitle">{t(locale, 'helpDesk.title')}</h1>
          <p className="hdSubtitle">{t(locale, 'helpDesk.subtitle')}</p>
        </div>
        {controls.addQuestion ? (
          <button type="button" className="hdPrimaryButton" onClick={() => setEditing({ question: null })}>
            ＋ {t(locale, 'helpDesk.addQuestion')}
          </button>
        ) : null}
      </header>

      <div className="hdTabs" role="tablist" aria-label={t(locale, 'helpDesk.title')}>
        {(['enquiries', 'questions'] as const).map((key) => (
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

      {access.readOnly ? <div className="hdReadOnly">{t(locale, 'helpDesk.readOnly')}</div> : null}

      {tab === 'enquiries' ? (
        <EnquiriesView locale={locale} ticketId={ticketId ?? null} canWrite={canWrite} />
      ) : (
        <QuestionsView
          locale={locale}
          canWrite={canWrite}
          refreshKey={questionsVersion}
          onEdit={(question) => setEditing({ question })}
        />
      )}

      {editing && controls.questionModal ? (
        <QuestionModal
          locale={locale}
          question={editing.question}
          defaultLocale={locale}
          onClose={() => setEditing(null)}
          onSaved={(_saved, outcome) => {
            // Enquiries Tab 上看不到列表，靠提示告诉员工已保存
            const next = afterQuestionSave(outcome)
            if (next.refresh) setQuestionsVersion((value) => value + 1)
            if (next.close) setEditing(null)
            if (next.toast === 'saved') message.success(t(locale, 'helpDesk.questions.saved'))
            else if (next.toast === 'gone') message.error(errorMessage(locale, 'QUESTION_NOT_FOUND'))
          }}
        />
      ) : null}
    </section>
  )
}
