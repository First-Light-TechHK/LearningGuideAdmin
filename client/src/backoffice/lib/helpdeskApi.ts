import {
  TIMELINE_LIMIT,
  type AcceptCandidateBody,
  type AcceptCandidateResult,
  type AgentActionInput,
  type AgentRun,
  type CandidateDetail,
  type CandidateList,
  type CandidateReview,
  type FaqMap,
  type FaqRewriteBody,
  type FaqRewriteResult,
  type MergeCandidateBody,
  type MergeCandidateResult,
  type DismissCandidateBody,
  type EnquiryDetail,
  type EnquiryList,
  type FaqBody,
  type FaqCandidate,
  type FaqCandidateDraft,
  type FaqEdgeRow,
  type FaqEdges,
  type FaqEdgeView,
  type FaqGraphPreview,
  type FaqPage,
  type FaqPhrasing,
  type FaqRelease,
  type FaqReleaseDiff,
  type FaqReleaseList,
  type FaqTree,
  type FaqWorkingCopy,
  type FlywheelJob,
  type FlywheelJobRun,
  type FlywheelMetrics,
  type FromTicketResult,
  type HelpdeskFaq,
  type HelpdeskLocale,
  type MetricsGranularity,
  type MetricsSplit,
  type PhrasingLocale,
  type PortalJobRunResult,
  type PortalJobRuns,
} from '../contracts/helpdesk'
import { faqQuery, type FaqFilters } from './helpdeskFaqs'
import { candidateQuery, metricsQuery, type CandidateFilters } from './helpdeskFlywheel'
import { enquiryQuery, type EnquiryFilters } from './helpdeskView'
import { notifySessionChanged } from './navigation'

/**
 * HelpDesk 接口（设计文档 §5.4）。与 boRequest 一样解统一信封，但保留 HelpDesk 自己的错误码
 * （HELPDESK_NOT_CONNECTED / STALE_TICKET / VERSION_CONFLICT …），页面按码显示文案。
 * 浏览器只调 BackOffice Server，从不直连 Portal。
 */
export type HelpdeskResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number }

async function request<T>(url: string, init?: RequestInit): Promise<HelpdeskResult<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...init })
    // 会话失效或角色刚被改：让外壳重读 /api/session
    if (response.status === 401 || response.status === 403) notifySessionChanged()
    const body = (await response.json().catch(() => null)) as {
      success?: boolean
      data?: T
      error?: { code?: string } | null
    } | null
    if (body?.success === true) return { ok: true, data: body.data as T }
    const code = body?.error?.code
    return { ok: false, code: typeof code === 'string' && code !== '' ? code : 'INTERNAL_ERROR', status: response.status }
  } catch {
    return { ok: false, code: 'HELPDESK_UNAVAILABLE', status: 0 }
  }
}

function sendJson<T>(method: 'POST' | 'PUT' | 'DELETE', url: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  return request<T>(url, { method, headers, body: JSON.stringify(body) })
}

const ticketPath = (ticketId: string) => `/api/helpdesk/tickets/${encodeURIComponent(ticketId)}`
const faqPath = (faqId: string) => `/api/helpdesk/faqs/${encodeURIComponent(faqId)}`

/* ---------------------------------- Enquiries ---------------------------------- */

export function listEnquiries(filters: EnquiryFilters, cursor?: string | null) {
  return request<EnquiryList>(`/api/helpdesk/tickets?${enquiryQuery(filters, cursor)}`)
}

/** 学员时间线（Figma 1324:2 中栏）：这个学员最多 10 条工单，新的在前。 */
export function listTimeline(learnerId: string) {
  const query = new URLSearchParams({ learnerId, limit: String(TIMELINE_LIMIT) })
  return request<EnquiryList>(`/api/helpdesk/tickets?${query.toString()}`)
}

export function getEnquiry(ticketId: string) {
  return request<EnquiryDetail>(ticketPath(ticketId))
}

export function sendMessage(
  ticketId: string,
  input: { body: string; internal: boolean; expectedSequence: number },
  idempotencyKey: string,
) {
  return sendJson<EnquiryDetail>('POST', `${ticketPath(ticketId)}/messages`, input, idempotencyKey)
}

/** claim / propose_resolution（Mark as reviewed）/ add_tag / remove_tag / mark_read / flag / unflag。 */
export function sendAction(ticketId: string, input: AgentActionInput, idempotencyKey: string) {
  return sendJson<EnquiryDetail>('POST', `${ticketPath(ticketId)}/actions`, input, idempotencyKey)
}

/** 「查看链路」：一次 AI 推荐的 run（导出副本，学员原文已脱敏）；没有记录时 AGENT_RUN_NOT_FOUND。 */
export function getAgentRun(runId: string) {
  return request<AgentRun>(`/api/helpdesk/agent-runs/${encodeURIComponent(runId)}`)
}

/** 附件走 BackOffice Server 代理（图片内联、其它下载）。 */
export function attachmentUrl(attachmentId: string): string {
  return `/api/helpdesk/attachments/${encodeURIComponent(attachmentId)}`
}

/** Idempotency-Key：一次提交一个 UUID v4，重试沿用（Server 只收 UUID）。 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* ------------------------------------ FAQs ------------------------------------ */

export function listFaqs(filters: FaqFilters) {
  return request<FaqPage>(`/api/helpdesk/faqs?${faqQuery(filters)}`)
}

/** 版本冲突后取最新版本（抽屉保留草稿，用新 version 重试）。 */
export function getFaq(faqId: string) {
  return request<HelpdeskFaq>(faqPath(faqId))
}

/** 新建：Idempotency-Key 防止重复提交生成两条。 */
export function createFaq(body: FaqBody, idempotencyKey: string) {
  return sendJson<HelpdeskFaq>('POST', '/api/helpdesk/faqs', body, idempotencyKey)
}

export function updateFaq(faqId: string, body: FaqBody & { version: number }) {
  return sendJson<HelpdeskFaq>('PUT', faqPath(faqId), body)
}

/** Delete FAQ = 归档（幂等）。 */
export function archiveFaq(faqId: string, version: number) {
  return sendJson<HelpdeskFaq>('POST', `${faqPath(faqId)}/archive`, { version })
}

/* --------------------------- v5 问题树（graph design §5） --------------------------- */

const releasePath = (version: number) => `/api/helpdesk/faq-releases/${encodeURIComponent(String(version))}`

/** 一个节点的子节点（按顺序，解析好的文字）与父节点。 */
export function getFaqEdges(faqId: string) {
  return request<FaqEdges>(`${faqPath(faqId)}/edges`)
}

/** 加一条追问 / 选项（kind 由父节点类型决定；同一对父子再加一次返回已有的）。 */
export function createFaqEdge(parentId: string, body: { childId: string; labelEn?: string | null; labelZh?: string | null }) {
  return sendJson<FaqEdgeRow>('POST', `${faqPath(parentId)}/edges`, body)
}

/** 改覆盖文字：两种语言都给，null = 用子节点的问题。 */
export function updateFaqEdge(edgeId: string, labels: { labelEn: string | null; labelZh: string | null }) {
  return sendJson<FaqEdgeRow>('PUT', `/api/helpdesk/faq-edges/${encodeURIComponent(edgeId)}`, labels)
}

export function deleteFaqEdge(edgeId: string) {
  return sendJson<{ deleted: boolean }>('DELETE', `/api/helpdesk/faq-edges/${encodeURIComponent(edgeId)}`, {})
}

/** 重排：完整的子节点 id 列表（列表过期 → 409 FAQ_CHILDREN_CHANGED）。 */
export function reorderFaqEdges(parentId: string, childIds: string[]) {
  return sendJson<{ children: FaqEdgeView[] }>('PUT', `${faqPath(parentId)}/edges/order`, { childIds })
}

export function getFaqTree(faqId: string) {
  return request<FaqTree>(`${faqPath(faqId)}/tree`)
}

export function listPhrasings(faqId: string) {
  return request<{ phrasings: FaqPhrasing[] }>(`${faqPath(faqId)}/phrasings`)
}

export function addPhrasing(faqId: string, body: { locale: PhrasingLocale; text: string }) {
  return sendJson<FaqPhrasing>('POST', `${faqPath(faqId)}/phrasings`, body)
}

export function deletePhrasing(phrasingId: string) {
  return sendJson<{ deleted: boolean }>('DELETE', `/api/helpdesk/faq-phrasings/${encodeURIComponent(phrasingId)}`, {})
}

export function listReleases() {
  return request<FaqReleaseList>('/api/helpdesk/faq-releases')
}

/** 工作副本的检查与它和当前上线版本的差异（只读）。 */
export function getWorkingCopy() {
  return request<FaqWorkingCopy>('/api/helpdesk/faq-releases/working')
}

/** 一个版本和它的前一个上线版本（或 base）的差异。 */
export function getReleaseDiff(version: number) {
  return request<FaqReleaseDiff>(`${releasePath(version)}/diff`)
}

/** 冻结工作副本成新版本并跑检查与评测门（工作副本没变 → 返回已有的那一版）。 */
export function createRelease() {
  return sendJson<FaqRelease>('POST', '/api/helpdesk/faq-releases', {})
}

export function checkRelease(version: number) {
  return sendJson<FaqRelease>('POST', `${releasePath(version)}/check`, {})
}

export function publishRelease(version: number) {
  return sendJson<FaqRelease>('POST', `${releasePath(version)}/publish`, {})
}

export function rollbackRelease(version: number) {
  return sendJson<FaqRelease>('POST', `${releasePath(version)}/rollback`, {})
}

/** 对话预览：工作副本（缺省）或某个版本，按 Portal 的样子投影成一种语言。 */
export function getGraphPreview(locale: HelpdeskLocale, version?: number) {
  const query = new URLSearchParams({ locale })
  if (version !== undefined) query.set('version', String(version))
  return request<FaqGraphPreview>(`/api/helpdesk/faq-releases/preview?${query.toString()}`)
}

/* ------------------------ v5 Part G 数据飞轮（G3 / G4 / G6，待视觉验收） ------------------------ */

const candidatePath = (candidateId: string) => `/api/helpdesk/faq-candidates/${encodeURIComponent(candidateId)}`
const jobPath = (job: FlywheelJob) => `/api/helpdesk/flywheel/jobs/${encodeURIComponent(job)}`

/** 候选队列：条数多的在前；带各状态的条数与相关节点的摘要。 */
export function listCandidates(filters: CandidateFilters) {
  return request<CandidateList>(`/api/helpdesk/faq-candidates?${candidateQuery(filters)}`)
}

/** 一个候选、它的修订（审计）与相关节点。 */
export function getCandidate(candidateId: string) {
  return request<CandidateDetail>(candidatePath(candidateId))
}

/** 新 FAQ / 追问的预填（不写任何东西；答案留空）。 */
export function getCandidateDraft(candidateId: string) {
  return request<FaqCandidateDraft>(`${candidatePath(candidateId)}/draft`)
}

/** 接受：加问法 / 新 FAQ / 追问（新 FAQ 与追问先经 POST faqs 建好节点再带 faqId）。同一个决定重试沿用 key。 */
export function acceptCandidate(candidateId: string, body: AcceptCandidateBody, idempotencyKey: string) {
  return sendJson<AcceptCandidateResult>('POST', `${candidatePath(candidateId)}/accept`, body, idempotencyKey)
}

export function dismissCandidate(candidateId: string, body: DismissCandidateBody, idempotencyKey: string) {
  return sendJson<{ candidate: FaqCandidate; replayed: boolean }>('POST', `${candidatePath(candidateId)}/dismiss`, body, idempotencyKey)
}

/** 「转成 FAQ 候选」：201 新建，200 这张工单已经转过（那一个）。 */
/** 审核数据：相似卡、建议位置、提问用户的状态、净值（只读，不调模型）。 */
export function getCandidateReview(candidateId: string) {
  return request<CandidateReview>(`${candidatePath(candidateId)}/review`)
}

/** 编辑区里的流程树和规则表（选位置用）。 */
export function getFaqMap() {
  return request<FaqMap>('/api/helpdesk/faq-map')
}

export function mergeCandidate(candidateId: string, body: MergeCandidateBody, idempotencyKey: string) {
  return sendJson<MergeCandidateResult>('POST', `${candidatePath(candidateId)}/merge`, body, idempotencyKey)
}

export function ticketToCandidate(ticketId: string) {
  return sendJson<FromTicketResult>('POST', `${ticketPath(ticketId)}/faq-candidate`, {})
}

export function listJobRuns(job: FlywheelJob) {
  return request<{ runs: FlywheelJobRun[] }>(`${jobPath(job)}/runs`)
}

export function getJobRun(job: FlywheelJob, runId: string) {
  return request<FlywheelJobRun>(`${jobPath(job)}/runs/${encodeURIComponent(runId)}`)
}

/** 立即运行（Idempotency-Key 必带）：201 新开一次（后台跑，轮询 getJobRun），200 同一个 key 的那一次。 */
export function runJobNow(job: FlywheelJob, idempotencyKey: string) {
  return sendJson<FlywheelJobRun>('POST', `${jobPath(job)}/run`, {}, idempotencyKey)
}

/** Portal 的学员原文保留任务（180 天后只留脱敏文字与标签）。 */
export function listRetentionRuns() {
  return request<PortalJobRuns>('/api/helpdesk/jobs/assist-retention')
}

export function runRetentionNow(idempotencyKey: string) {
  return sendJson<PortalJobRunResult>('POST', '/api/helpdesk/jobs/assist-retention/run', {}, idempotencyKey)
}

/** AI 按指令改卡（不保存）：失败时界面保留原文，只提示。 */
export function rewriteFaq(body: FaqRewriteBody) {
  return sendJson<FaqRewriteResult>('POST', '/api/helpdesk/faqs/rewrite', body)
}

export function getFlywheelMetrics(input: { granularity: MetricsGranularity; from: string; to: string; split: MetricsSplit }) {
  return request<FlywheelMetrics>(`/api/helpdesk/flywheel/metrics?${metricsQuery(input)}`)
}
