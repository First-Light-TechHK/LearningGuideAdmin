import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { FaqTree, GraphProblem, HelpdeskFaq } from '../contracts/helpdesk'
import { getFaqTree } from '../lib/helpdeskApi'
import { errorMessage } from '../lib/helpdeskFormat'
import { allPaths, initialExpanded } from '../lib/helpdeskGraph'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { FaqChatPreview } from './FaqChatPreview'
import { useModal } from './useModal'

/**
 * 问题树抽屉（helpdesk-v5-faq-graph-design §5.2 / §5.3）：从一条 FAQ 展开的工作副本，两个 Tab：
 * - 大纲：缩进的大纲，可展开 / 收起（全部展开 / 全部收起）；共享节点标「也出现在 N 处」并列出另外的父问题；
 *   图检查的提醒（层级、孤立、缺语言…）挂在节点下；环与超深的分支停住并标出；
 * - 对话预览：像学员一样点选项和追问（FaqChatPreview）。
 * 只读：helpDesk 的 VIEW 及以上都能打开。没有 Figma 画板：沿用 FAQ 抽屉的外壳、Tab 与提示样式（待视觉验收）。
 * 模态层同 FAQ 抽屉（useModal：Escape 关闭，Tab 不出抽屉，焦点还给入口）。
 */

type TabKey = 'outline' | 'chat'
const TABS: TabKey[] = ['outline', 'chat']

/** returnFocus：从 Preview 打开时，Preview 已经关了，焦点要回到打开 Preview 的按钮，而不是 body。 */
type Props = { locale: Locale; faq: HelpdeskFaq; onClose: () => void; returnFocus?: HTMLElement | null }
type State = { kind: 'loading' } | { kind: 'ready'; tree: FaqTree } | { kind: 'failed'; code: string }

function ruleText(locale: Locale, problem: GraphProblem): string {
  const key = `helpDesk.graph.rules.${problem.rule}`
  const text = t(locale, key)
  return text === key ? problem.detail : text
}

function countWarnings(tree: FaqTree): number {
  let count = 0
  const seen = new Set<string>()
  const visit = (node: FaqTree['root']) => {
    if (!seen.has(node.node.id)) {
      seen.add(node.node.id)
      count += node.warnings.length
    }
    node.children.forEach(visit)
  }
  visit(tree.root)
  return count
}

export function FaqTreeDrawer({ locale, faq, onClose, returnFocus }: Props) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const [tab, setTab] = useState<TabKey>('outline')
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  useModal(() => drawerRef.current, onClose)

  // 焦点回到哪儿只记第一次：StrictMode 下 effect 会跑两遍，第二遍时焦点已经在关闭按钮上
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    openerRef.current ??= returnFocus ?? (document.activeElement as HTMLElement | null)
    closeRef.current?.focus()
    return () => openerRef.current?.focus?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时记一次
  }, [])

  useEffect(() => {
    let live = true
    void getFaqTree(faq.id).then((result) => {
      if (!live) return
      if (result.ok) {
        setState({ kind: 'ready', tree: result.data })
        setExpanded(initialExpanded(result.data.root))
      } else setState({ kind: 'failed', code: result.code })
    })
    return () => {
      live = false
    }
  }, [faq.id])

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = (index + (event.key === 'ArrowLeft' ? -1 : 1) + TABS.length) % TABS.length
    setTab(TABS[next])
    tabRefs.current[next]?.focus()
  }

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const question = zh ? faq.questionZh : faq.questionEn

  /**
   * 一行 + 它展开的子节点：嵌套的列表（读屏软件按层报「列表，2 项」，听得出谁是谁的选项 / 追问）；
   * 选项字母既画出来（aria-hidden 的圆标）也读出来（hdSrOnly「选项 A：」）。
   */
  function branch(item: FaqTree['root'], path: string, level: number, index: number) {
    const hasChildren = item.children.length > 0
    const open = hasChildren && expanded.has(path)
    const nodeQuestion = zh ? item.node.questionZh : item.node.questionEn
    const label = item.label ? (zh ? item.label.zh : item.label.en) : nodeQuestion
    const others = item.alsoAppearsIn.map((parent) => (zh ? parent.questionZh : parent.questionEn))
    const letter = String.fromCharCode(65 + index)
    return (
      <li key={path} className="hdTreeRow">
        <div className="hdTreeRowBody" style={{ paddingInlineStart: `${level * 20}px` }}>
          <div className="hdTreeLine">
            {hasChildren ? (
              <button
                type="button"
                className="hdTreeToggle"
                aria-expanded={open}
                aria-label={t(locale, open ? 'helpDesk.tree.collapse' : 'helpDesk.tree.expand', { label })}
                onClick={() => toggle(path)}
              >
                <span aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
            ) : (
              <span className="hdTreeToggle hdTreeLeaf" aria-hidden="true" />
            )}
            {item.edge?.kind === 'option' ? (
              <>
                <span className="hdGraphLetter" aria-hidden="true">
                  {letter}
                </span>
                <span className="hdSrOnly">{t(locale, 'helpDesk.tree.optionLetter', { letter })}</span>
              </>
            ) : null}
            <div className="hdTreeText">
              <span className="hdGraphChildLabel">{label}</span>
              {label !== nodeQuestion ? <span className="hdGraphHint">{nodeQuestion}</span> : null}
            </div>
            <span className="hdTreeTags">
              {item.node.type === 'choice' ? <span className="hdGraphTag">{t(locale, 'helpDesk.tree.types.choice')}</span> : null}
              {item.node.entry ? <span className="hdGraphTag hdGraphTagEntry">{t(locale, 'helpDesk.tree.entry')}</span> : null}
              {others.length > 0 ? (
                <span className="hdGraphTag hdGraphTagShared" title={t(locale, 'helpDesk.tree.alsoInList', { questions: others.join(' · ') })}>
                  {others.length === 1 ? t(locale, 'helpDesk.tree.alsoInOne') : t(locale, 'helpDesk.tree.alsoIn', { count: others.length })}
                </span>
              ) : null}
            </span>
          </div>
          {others.length > 0 ? (
            <p className="hdGraphHint hdTreeNote">{t(locale, 'helpDesk.tree.alsoInList', { questions: others.join(' · ') })}</p>
          ) : null}
          {item.cycle ? <p className="hdGraphHint hdTreeNote">{t(locale, 'helpDesk.tree.cycle')}</p> : null}
          {item.truncated ? <p className="hdGraphHint hdTreeNote">{t(locale, 'helpDesk.tree.truncated')}</p> : null}
          {item.warnings.length > 0 ? (
            <ul className="hdTreeWarnings">
              {item.warnings.map((problem, at) => (
                <li key={`${problem.rule}-${at}`} className="hdFieldError">
                  {ruleText(locale, problem)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {open ? (
          <ul className="hdTreeBranch" aria-label={label}>
            {item.children.map((child, at) => branch(child, `${path}/${child.node.id}`, level + 1, at))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <div className="hdDrawerLayer">
      <div className="hdDrawerBackdrop" aria-hidden="true" onClick={onClose} />
      <aside ref={drawerRef} className="hdDrawer hdTreeDrawer" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`}>
        <header className="hdDrawerHead">
          <div className="hdDrawerHeading">
            <h2 className="hdDrawerTitle" id={`${uid}-title`}>
              {t(locale, 'helpDesk.tree.title')}
            </h2>
            <p className="hdDrawerSubtitle">{question}</p>
          </div>
          <button ref={closeRef} type="button" className="hdDrawerClose" aria-label={t(locale, 'helpDesk.drawer.close')} onClick={onClose}>
            ×
          </button>
        </header>

        <div className="hdTabs hdTreeTabs" role="tablist" aria-label={t(locale, 'helpDesk.tree.title')}>
          {TABS.map((key, index) => (
            <button
              key={key}
              ref={(node) => {
                tabRefs.current[index] = node
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`${uid}-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              className={`hdTab${tab === key ? ' hdTabActive' : ''}`}
              onClick={() => setTab(key)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {t(locale, `helpDesk.tree.tabs.${key}`)}
            </button>
          ))}
        </div>

        <div className="hdDrawerBody" role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`}>
          {tab === 'outline' ? (
            <>
              <p className="hdGraphHint">{t(locale, 'helpDesk.tree.subtitle')}</p>
              {state.kind === 'loading' ? <p className="hdGraphHint">{t(locale, 'helpDesk.releases.loading')}</p> : null}
              {state.kind === 'failed' ? (
                <div className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert">
                  {errorMessage(locale, state.code)}
                </div>
              ) : null}
              {state.kind === 'ready' ? (
                <>
                  <div className="hdTreeSummary">
                    <span>{t(locale, 'helpDesk.tree.nodes', { count: state.tree.nodes })}</span>
                    <span>
                      {countWarnings(state.tree) > 0
                        ? t(locale, 'helpDesk.tree.warnings', { count: countWarnings(state.tree) })
                        : t(locale, 'helpDesk.tree.noWarnings')}
                    </span>
                    <span className="hdDrawerSpacer" />
                    <button type="button" className="hdLinkButton" onClick={() => setExpanded(allPaths(state.tree.root))}>
                      {t(locale, 'helpDesk.tree.expandAll')}
                    </button>
                    <button type="button" className="hdLinkButton" onClick={() => setExpanded(new Set())}>
                      {t(locale, 'helpDesk.tree.collapseAll')}
                    </button>
                  </div>
                  <ul className="hdTreeOutline" aria-label={t(locale, 'helpDesk.tree.outlineLabel')}>
                    {branch(state.tree.root, state.tree.root.node.id, 0, 0)}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <FaqChatPreview locale={locale} startId={faq.id} />
          )}
        </div>
      </aside>
    </div>
  )
}
