import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import type { FaqMapNode, ReviewPlace, ReviewRegion } from '../contracts/helpdesk'
import { buildMapTree, isPlaceable, mapPath, openRoots, pathLabel, pathText, type MapTreeNode } from '../lib/helpdeskReview'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * 「放在哪」：AI 建议的至多 3 个位置做成一排可点的胶囊（只是提示，离线前 3 里有正确节点只有 45.7%），
 * 「其他位置…」打开整棵树的浮层（盖在决定栏上，带搜索；默认展开建议的区域，前 3 个区域里有正确区域 86.6%）。
 * 只有步骤、偏离、规则格能选；阶段和对象只是分组。不预选：员工必须自己点。没有 Figma，待视觉验收。
 */

type ChipsProps = {
  locale: Locale
  nodes: readonly FaqMapNode[]
  places: readonly ReviewPlace[]
  selected: string | null
  onSelect: (id: string) => void
  onOpenTree: () => void
  disabled?: boolean
  required: boolean
  invalid?: boolean
  errorId?: string
}

export function PlaceChips({
  locale,
  nodes,
  places,
  selected,
  onSelect,
  onOpenTree,
  disabled = false,
  required,
  invalid = false,
  errorId,
}: ChipsProps) {
  const uid = useId()
  const known = new Set(nodes.map((node) => node.id))
  const suggested = places.filter((place) => known.has(place.nodeId))
  const picked = selected && !suggested.some((place) => place.nodeId === selected) ? mapPath(nodes, selected) : []

  return (
    <fieldset className="hdReviewFieldset" aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}>
      <legend className="hdReviewLabel">
        {t(locale, required ? 'helpDesk.review.place.legendRequired' : 'helpDesk.review.place.legendOptional')}
        {required ? <span className="hdReviewStar"> *</span> : null}
      </legend>
      <div className="hdReviewChips">
        {suggested.map((place, index) => {
          const on = selected === place.nodeId
          return (
            <label key={place.nodeId} className={`hdReviewChip${on ? ' hdReviewChipOn' : ''}`} title={pathText(place.path, locale)}>
              <input
                type="radio"
                className="hdSrOnly"
                name={`${uid}-place`}
                checked={on}
                disabled={disabled}
                onChange={() => onSelect(place.nodeId)}
              />
              <span className="hdReviewChipRank" aria-hidden="true">
                {index + 1}
              </span>
              <span className="hdReviewChipText">{pathText(place.path, locale)}</span>
            </label>
          )
        })}
        {picked.length > 0 ? (
          <span className="hdReviewChip hdReviewChipOn" title={picked.map((node) => pathLabel(node, locale)).join(' › ')}>
            <span className="hdReviewChipText">{picked.map((node) => pathLabel(node, locale)).join(' › ')}</span>
          </span>
        ) : null}
        <button type="button" className="hdReviewChip hdReviewChipGhost" disabled={disabled} onClick={onOpenTree}>
          {t(locale, 'helpDesk.review.place.other')}
        </button>
      </div>
    </fieldset>
  )
}

type TreeProps = {
  locale: Locale
  nodes: readonly FaqMapNode[]
  regions: readonly ReviewRegion[]
  selected: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

/** 整棵树的浮层：搜索框过滤（命中的节点和它的上级都留着，搜索时全部展开），点一个就选中并关上。 */
export function PlaceTreePanel({ locale, nodes, regions, selected, onSelect, onClose }: TreeProps) {
  const uid = useId()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const q = query.trim().toLowerCase()
  const keep = new Set<string>()
  if (q) {
    for (const node of nodes) {
      if ([node.labelZh, node.labelEn, node.key].some((text) => text.toLowerCase().includes(q)))
        for (const step of mapPath(nodes, node.id)) keep.add(step.id)
    }
  }
  const roots = openRoots(
    nodes,
    regions.map((region) => region.key),
    selected,
  )
  const regionKeys = new Set(regions.map((region) => region.key))

  function branch(item: MapTreeNode, depth: number): ReactNode {
    const { node, children } = item
    if (q && !keep.has(node.id)) return null
    const label = pathLabel(node, locale)
    const kids = children.map((child) => branch(child, depth + 1))
    if (isPlaceable(node)) {
      const on = selected === node.id
      return (
        <li key={node.id}>
          <label className={`hdReviewTreeItem${on ? ' hdReviewTreeItemOn' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
            <input
              type="radio"
              className="hdReviewRadio"
              name={`${uid}-tree`}
              checked={on}
              onChange={() => {
                onSelect(node.id)
                onClose()
              }}
            />
            <span className="hdReviewTreeLabel">{label}</span>
            <span className="hdReviewTreeMeta">
              {t(locale, `helpDesk.review.place.kind.${node.kind}`)} · {t(locale, 'helpDesk.review.place.cards', { count: node.cards })}
            </span>
          </label>
          {children.length > 0 ? <ul className="hdReviewTreeList">{kids}</ul> : null}
        </li>
      )
    }
    if (depth === 0)
      return (
        <li key={node.id}>
          <details className="hdReviewTreeRoot" open={Boolean(q) || roots.has(node.key)}>
            <summary className="hdReviewTreeSummary">
              <span>{label}</span>
              <span className="hdGraphTag">{t(locale, `helpDesk.review.place.kind.${node.kind}`)}</span>
              {regionKeys.has(node.key) ? (
                <span className="hdGraphTag hdReviewTagBlue">{t(locale, 'helpDesk.review.place.suggestedRegion')}</span>
              ) : null}
            </summary>
            <ul className="hdReviewTreeList">{kids}</ul>
          </details>
        </li>
      )
    return (
      <li key={node.id}>
        <p className="hdReviewTreeGroup" style={{ paddingLeft: 8 + depth * 14 }}>
          {label}
        </p>
        <ul className="hdReviewTreeList">{kids}</ul>
      </li>
    )
  }

  const tree = buildMapTree(nodes)
  const empty = q !== '' && keep.size === 0
  return (
    <div
      className="hdReviewOverlay"
      role="dialog"
      aria-labelledby={`${uid}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="hdReviewOverlayHead">
        <h4 className="hdGraphTitle" id={`${uid}-title`}>
          {t(locale, 'helpDesk.review.place.treeTitle')}
        </h4>
        <button type="button" className="hdDrawerClose" aria-label={t(locale, 'helpDesk.drawer.close')} onClick={onClose}>
          ×
        </button>
      </div>
      <input
        ref={inputRef}
        type="search"
        className="hdReviewInput"
        value={query}
        placeholder={t(locale, 'helpDesk.review.place.search')}
        aria-label={t(locale, 'helpDesk.review.place.search')}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="hdReviewTree" aria-label={t(locale, 'helpDesk.review.place.tree')}>
        {tree.map((item) => branch(item, 0))}
      </ul>
      {empty ? <p className="hdGraphHint">{t(locale, 'helpDesk.review.place.noMatch')}</p> : null}
    </div>
  )
}
