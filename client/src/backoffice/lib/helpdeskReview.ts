import {
  PLACEABLE_KINDS,
  USER_STATE_BUCKETS,
  type CandidateReview,
  type CandidateSuggestion,
  type FaqCandidate,
  type FaqMapNode,
  type MapPathItem,
  type ReviewSimilar,
  type UserStateBucket,
} from '../contracts/helpdesk'
import type { Locale } from './i18n/config'

/**
 * FAQ 候选「卡片审核」的纯逻辑（api-spec：/mnt/project-files/lg-helpdesk/candidate-review/api-spec.md）。
 * 产品规则（owner 2026-10-31）：AI 只给建议；员工看用户原话、AI 当时怎么处理、相似卡、位置、提问用户的状态和净值，
 * 再批准。批准的改动进编辑区，下次发版过评测门才上线。
 *
 * 四种动作（Mem0 的 ADD / UPDATE / DELETE / NOOP）对应五种建议：
 * - 新增：new_faq（独立新卡）、follow_up（某张卡下的追问）
 * - 更新已有卡：update_faq（改卡的内容）、add_phrasing（只加问法）
 * - 标记失效：retire_faq（归档，不删除）
 * - 不改动：no_change（= 驳回，原因 not_a_gap）
 */

export const REVIEW_GROUPS = ['add', 'update', 'retire', 'none'] as const
export type ReviewGroup = (typeof REVIEW_GROUPS)[number]
export type ReviewAction = CandidateSuggestion | 'no_change'

export const GROUP_ACTIONS: Record<ReviewGroup, readonly ReviewAction[]> = {
  add: ['new_faq', 'follow_up'],
  update: ['update_faq', 'add_phrasing'],
  retire: ['retire_faq'],
  none: ['no_change'],
}

export function groupOf(action: ReviewAction): ReviewGroup {
  return REVIEW_GROUPS.find((group) => GROUP_ACTIONS[group].includes(action)) ?? 'none'
}

/** 动作要员工选什么：目标卡（追问时是上一级问题）、位置、勾选例句。 */
export function needsTarget(action: ReviewAction): boolean {
  return action === 'follow_up' || action === 'add_phrasing' || action === 'update_faq' || action === 'retire_faq'
}

/** new_faq / follow_up 在结构不为空时必须选位置；update_faq 可选（换位置）。 */
export function placeMode(action: ReviewAction, mapHasNodes: boolean): 'required' | 'optional' | 'hidden' {
  if (!mapHasNodes) return 'hidden'
  if (action === 'new_faq' || action === 'follow_up') return 'required'
  if (action === 'update_faq') return 'optional'
  return 'hidden'
}

export function usesPhrasings(action: ReviewAction): boolean {
  return action === 'new_faq' || action === 'follow_up' || action === 'add_phrasing' || action === 'update_faq'
}

export type ReviewChoice = {
  action: ReviewAction
  target: string | null
  place: string | null
  moveTo: string | null
  picks: number[]
}

/** AI 建议的缺省选择：动作 = 建议；目标 = 建议的卡（没有时退回候选的相关节点）；位置不预选（必须员工选）。 */
export function defaultChoice(
  candidate: Pick<FaqCandidate, 'suggestion' | 'relatedNodeId' | 'parentNodeId'>,
  review: Pick<CandidateReview, 'recommendation'> | null,
  picks: number[],
): ReviewChoice {
  const action = review?.recommendation.action ?? candidate.suggestion
  const fallback = action === 'follow_up' ? candidate.parentNodeId : candidate.relatedNodeId
  return {
    action,
    target: needsTarget(action) ? (review?.recommendation.faqId ?? fallback ?? null) : null,
    place: null,
    moveTo: null,
    picks,
  }
}

/** 换动作：目标对新动作没有意义时清掉；同一类里换（例如改内容 ↔ 只加问法）保留目标。 */
export function switchAction(choice: ReviewChoice, action: ReviewAction, recommendedTarget: string | null): ReviewChoice {
  if (choice.action === action) return choice
  const target = needsTarget(action) ? (choice.target ?? recommendedTarget) : null
  return {
    ...choice,
    action,
    target,
    moveTo: action === 'retire_faq' ? choice.moveTo : null,
  }
}

export type ReviewProblem = 'needTarget' | 'needPlace' | 'needExamples' | 'moveToSelf'

export function choiceProblems(choice: ReviewChoice, mapHasNodes: boolean): ReviewProblem[] {
  const problems: ReviewProblem[] = []
  if (needsTarget(choice.action) && !choice.target) problems.push('needTarget')
  if (placeMode(choice.action, mapHasNodes) === 'required' && !choice.place) problems.push('needPlace')
  if (choice.action === 'add_phrasing' && choice.picks.length === 0) problems.push('needExamples')
  if (choice.action === 'retire_faq' && choice.moveTo && choice.moveTo === choice.target) problems.push('moveToSelf')
  return problems
}

/** 相似卡：同位置在前，再按分数从高到低（服务端已排，这里保证一次）；最多 10 张。 */
export function orderSimilar(similar: readonly ReviewSimilar[]): ReviewSimilar[] {
  return [...similar]
    .sort((a, b) => Number(b.samePlace) - Number(a.samePlace) || b.score - a.score || a.faqId.localeCompare(b.faqId))
    .slice(0, 10)
}

export const pathLabel = (item: Pick<MapPathItem, 'labelZh' | 'labelEn'>, locale: Locale) =>
  locale === 'zh-CN' ? item.labelZh : item.labelEn

export function pathText(path: readonly MapPathItem[], locale: Locale): string {
  return path.map((item) => pathLabel(item, locale)).join(' › ')
}

export function isPlaceable(node: Pick<FaqMapNode, 'kind'>): boolean {
  return (PLACEABLE_KINDS as readonly string[]).includes(node.kind)
}

export type MapTreeNode = { node: FaqMapNode; children: MapTreeNode[] }

/** 平铺的节点 → 树（按 position 再按 key）；父节点不在列表里的当作根。 */
export function buildMapTree(nodes: readonly FaqMapNode[]): MapTreeNode[] {
  const byParent = new Map<string | null, FaqMapNode[]>()
  const ids = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    byParent.set(parent, [...(byParent.get(parent) ?? []), node])
  }
  const order = (a: FaqMapNode, b: FaqMapNode) =>
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key)
  const seen = new Set<string>()
  const grow = (parent: string | null): MapTreeNode[] =>
    (byParent.get(parent) ?? [])
      .filter((node) => !seen.has(node.id) && seen.add(node.id))
      .sort(order)
      .map((node) => ({ node, children: grow(node.id) }))
  return grow(null)
}

/** 一个节点从根到自己的路径（选择器里「已选」那一行用）。 */
export function mapPath(nodes: readonly FaqMapNode[], id: string): FaqMapNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const out: FaqMapNode[] = []
  let at = byId.get(id)
  while (at && !out.includes(at)) {
    out.unshift(at)
    at = at.parentId ? byId.get(at.parentId) : undefined
  }
  return out
}

/** 根节点（阶段 / 对象）是不是要默认展开：建议的区域，或已选节点所在的根。 */
export function openRoots(nodes: readonly FaqMapNode[], regionKeys: readonly string[], selected: string | null): Set<string> {
  const open = new Set(regionKeys)
  if (selected) {
    const root = mapPath(nodes, selected)[0]
    if (root) open.add(root.key)
  }
  return open
}

export type StateShare = {
  bucket: UserStateBucket
  count: number
  percent: number
}

/** 提问用户的状态：按固定顺序，0 不显示，百分比四舍五入到整数。 */
export function stateShares(buckets: Partial<Record<UserStateBucket, number>>, total: number): StateShare[] {
  const sum = total > 0 ? total : USER_STATE_BUCKETS.reduce((acc, key) => acc + (buckets[key] ?? 0), 0)
  return USER_STATE_BUCKETS.map((bucket) => ({
    bucket,
    count: buckets[bucket] ?? 0,
  }))
    .filter((share) => share.count > 0)
    .map((share) => ({
      ...share,
      percent: sum > 0 ? Math.round((share.count / sum) * 100) : 0,
    }))
}

/** 批准后，队列里下一条（当前这条之后的；最后一条就退回前一条）。 */
export function nextInQueue(ids: readonly string[], current: string): string | null {
  const at = ids.indexOf(current)
  if (at === -1) return ids[0] ?? null
  return ids[at + 1] ?? ids[at - 1] ?? null
}

export const scorePercent = (score: number) => `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
