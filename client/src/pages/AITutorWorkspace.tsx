import { useState } from 'react'
import { MainLayout } from '../components/layout/MainLayout'
import { AITutor, AITutorTopBar, type AITutorTab } from './AITutor'
import { AITutorFeedback } from './AITutorFeedback'

export function AITutorWorkspace() {
  const [tab, setTab] = useState<AITutorTab>('tutor')
  const [feedbackOpened, setFeedbackOpened] = useState(false)
  const changeTab = (next: AITutorTab) => {
    if (next === 'feedback') setFeedbackOpened(true)
    setTab(next)
  }
  return (
    <MainLayout topBar={<AITutorTopBar active={tab} onChange={changeTab} />}>
      {/* 保留挂载，避免 Tab 切换重置未保存配置或中断回复。 */}
      <div id="ai-tutor-panel" role="tabpanel" aria-labelledby="ai-tutor-tab" hidden={tab !== 'tutor'} style={{ height: '100%' }}><AITutor /></div>
      <div id="ai-feedback-panel" role="tabpanel" aria-labelledby="ai-feedback-tab" hidden={tab !== 'feedback'} style={{ height: '100%' }}>{feedbackOpened && <AITutorFeedback />}</div>
    </MainLayout>
  )
}
