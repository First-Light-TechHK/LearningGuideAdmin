import { useId, useState } from 'react'

import type { FaqMapNode, ReviewPlace, ReviewRegion } from '../contracts/helpdesk'
import { buildMapTree, isPlaceable, mapPath, openRoots, pathLabel, pathText, type MapTreeNode } from '../lib/helpdeskReview'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * 选主位置（流程树的步骤 / 偏离，或规则表的格子）。没有 Figma，沿用候选详情的单选与标签样式，待视觉验收。
 * - 先列 AI 建议的至多 3 个位置（只是提示：离线前 3 里有正确节点只有 45.7%）；
 * - 「在整棵树里选」展开整棵树，默认展开建议的区域（前 3 个区域里有正确区域 86.6%）；
 * - 只有步骤、偏离、规则格能选；阶段和对象只是分组。不预选：员工必须自己点。
 */

type Props = {
  locale: Locale
  nodes: readonly FaqMapNode[]
  places: readonly ReviewPlace[]
  regions: readonly ReviewRegion[]
  selected: string | null
  onSelect: (id: string) => void
  disabled?: boolean
  required: boolean
  invalid?: boolean
  describedBy?: string
}

export function PlacePicker({
  locale,
  nodes,
  places,
  regions,
  selected,
  onSelect,
  disabled = false,
  required,
  invalid = false,
  describedBy,
}: Props) {
  const uid = useId()
  // 必选且没有建议时直接展开树；可选（换位置）时收起，免得盖住决定按钮
  const [treeOpen, setTreeOpen] = useState(
    () => (required && places.length === 0) || (selected !== null && !places.some((place) => place.nodeId === selected)),
  )
  const known = new Set(nodes.map((node) => node.id))
  const suggested = places.filter((place) => known.has(place.nodeId) || nodes.length === 0)
  const roots = openRoots(
    nodes,
    regions.map((region) => region.key),
    selected,
  )
  const selectedPath = selected ? mapPath(nodes, selected) : []

  function radio(group: 'suggested' | 'tree', id: string, label: string, extra?: string) {
    return (
      <label className={`hdReviewOption${selected === id ? ' hdReviewOptionOn' : ''}`}>
        <input
          type="radio"
          className="hdReviewRadio"
          name={`${uid}-${group}`}
          value={id}
          checked={selected === id}
          disabled={disabled}
          onChange={() => onSelect(id)}
        />
        <span className="hdReviewOptionText">
          <span>{label}</span>
          {extra ? <span className="hdGraphHint">{extra}</span> : null}
        </span>
      </label>
    )
  }

  function branch(item: MapTreeNode, depth: number) {
    const { node, children } = item
    const label = pathLabel(node, locale)
    const count = t(locale, 'helpDesk.review.place.cards', {
      count: node.cards,
    })
    if (isPlaceable(node))
      return (
        <li key={node.id} className="hdReviewTreeLeaf" style={{ paddingLeft: depth * 14 }}>
          {radio('tree', node.id, label, `${t(locale, `helpDesk.review.place.kind.${node.kind}`)} · ${count}`)}
          {children.length > 0 ? <ul className="hdReviewTreeList">{children.map((child) => branch(child, depth + 1))}</ul> : null}
        </li>
      )
    if (depth === 0)
      return (
        <li key={node.id}>
          <details className="hdReviewTreeRoot" open={roots.has(node.key)}>
            <summary className="hdReviewTreeSummary">
              <span>{label}</span>
              <span className="hdGraphTag">{t(locale, `helpDesk.review.place.kind.${node.kind}`)}</span>
              {regions.some((region) => region.key === node.key) ? (
                <span className="hdGraphTag hdReviewTagBlue">{t(locale, 'helpDesk.review.place.suggestedRegion')}</span>
              ) : null}
            </summary>
            <ul className="hdReviewTreeList">{children.map((child) => branch(child, 1))}</ul>
          </details>
        </li>
      )
    return (
      <li key={node.id} style={{ paddingLeft: depth * 14 }}>
        <p className="hdReviewTreeGroup">{label}</p>
        <ul className="hdReviewTreeList">{children.map((child) => branch(child, depth + 1))}</ul>
      </li>
    )
  }

  return (
    <fieldset
      className="hdReviewFieldset"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      aria-required={required || undefined}
    >
      <legend className="hdFieldLabel">
        {t(locale, required ? 'helpDesk.review.place.legendRequired' : 'helpDesk.review.place.legendOptional')}
        {required ? (
          <span className="hdRequired" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </legend>
      <p className="hdGraphHint">{t(locale, 'helpDesk.review.place.hint')}</p>

      {suggested.length > 0 ? (
        <div className="hdReviewOptions" role="group" aria-label={t(locale, 'helpDesk.review.place.suggested')}>
          {suggested.map((place, index) => (
            <div key={place.nodeId} className="hdReviewPlace">
              {radio(
                'suggested',
                place.nodeId,
                pathText(place.path, locale),
                `${t(locale, 'helpDesk.review.place.rank', { rank: index + 1 })} · ${t(locale, `helpDesk.review.place.kind.${place.kind}`)}`,
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="hdGraphHint">{t(locale, 'helpDesk.review.place.noSuggestion')}</p>
      )}

      {selected && selectedPath.length > 0 && !suggested.some((place) => place.nodeId === selected) ? (
        <p className="hdReviewPicked">
          {t(locale, 'helpDesk.review.place.picked', {
            path: selectedPath.map((node) => pathLabel(node, locale)).join(' › '),
          })}
        </p>
      ) : null}

      <button
        type="button"
        className="hdFaqPreview hdReviewTreeToggle"
        aria-expanded={treeOpen}
        aria-controls={`${uid}-tree`}
        onClick={() => setTreeOpen((open) => !open)}
      >
        {t(locale, treeOpen ? 'helpDesk.review.place.hideTree' : 'helpDesk.review.place.showTree')}
      </button>
      {treeOpen ? (
        <ul className="hdReviewTree" id={`${uid}-tree`} aria-label={t(locale, 'helpDesk.review.place.tree')}>
          {buildMapTree(nodes).map((item) => branch(item, 0))}
        </ul>
      ) : null}
    </fieldset>
  )
}
