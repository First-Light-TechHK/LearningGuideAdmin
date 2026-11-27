import { useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Alert, Button, Spin } from '../components/ui'
import { useKText } from '../components/knowledge/i18n'
import { PageEditor } from '../components/knowledge/PageEditor'
import { PublishPanel } from '../components/knowledge/PublishPanel'
import { TeachingCardsPanel } from '../components/knowledge/TeachingCardsPanel'
import type { KnowledgeTabKey } from '../components/knowledge/KnowledgeTabBar'
import { useKnowledgeStore } from '../stores/knowledgeStore'

/**
 * 知识库主页内容区（§3.1；2026-10-19 改）。
 * 顶部整宽 Tab 栏（KnowledgeTabBar）由 App 经 MainLayout 的 topBar 插槽渲染，
 * 本组件只按选中的 Tab 键渲染对应内容：`pages` → 编辑器，`publish` → 版本发布面板。
 */
export function KnowledgeSystem({ tab }: { tab: KnowledgeTabKey }) {
  const loadCourses = useKnowledgeStore((s) => s.loadCourses)

  useEffect(() => {
    void loadCourses()
  }, [loadCourses])

  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      {tab === 'publish' ? <PublishPanel /> : tab === 'teaching' ? <TeachingCardsPanel /> : <PageWorkspace />}
    </div>
  )
}

function PageWorkspace() {
  const [params, setParams] = useSearchParams()
  const courseId = params.get('courseId')
  const pageId = params.get('pageId')
  const courses = useKnowledgeStore(s => s.courses)
  const loadingCourses = useKnowledgeStore(s => s.loading)
  const currentPage = useKnowledgeStore(s => s.draft?.pageId)
  const [failedPage, setFailedPage] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const { text } = useKText()
  useEffect(() => {
    if (!pageId || !courseId || !courses.some(course => course.id === courseId)) return
    let active = true
    const restore = async () => {
      const store = useKnowledgeStore.getState()
      if (store.selectedPageId === pageId && store.selectedCourseId === courseId) return
      if (retry || !store.details[courseId]) await store.refreshDetail(courseId)
      if (active) {
        await store.selectPage(courseId, pageId)
        if (active && useKnowledgeStore.getState().draft?.pageId !== pageId) setFailedPage(pageId)
      }
    }
    void restore().catch(() => { if (active) setFailedPage(pageId) })
    return () => { active = false }
  }, [courseId, pageId, courses, retry])

  useEffect(() => useKnowledgeStore.subscribe((state, previous) => {
    if (state.selectedPageId === previous.selectedPageId && state.selectedCourseId === previous.selectedCourseId) return
    if (state.selectedCourseId === courseId && state.selectedPageId === pageId) return
    setParams(state.selectedCourseId && state.selectedPageId
      ? { courseId: state.selectedCourseId, pageId: state.selectedPageId } : {})
  }), [courseId, pageId, setParams])
  if (pageId && currentPage !== pageId) {
    if (failedPage === pageId || (!loadingCourses && !courses.some(course => course.id === courseId))) {
      return <Alert type="warning" message={text('editor.pageUnavailable')} action={<Button onClick={() => {
        setFailedPage(null)
        setRetry(value => value + 1)
      }}>{text('common.retry')}</Button>} />
    }
    return <Spin />
  }
  return <PageEditor />
}
