// 组件测试用的假 BackOffice Server：替换 globalThis.fetch，按「方法 + 路径」应答统一信封，
// 记下每个请求（方法、路径、查询、Idempotency-Key、请求体），供断言。
import type {
  AvailableActions,
  EnquiryDetail,
  EnquiryRow,
  HelpdeskQuestion,
} from '../../src/backoffice/contracts/helpdesk'
import type { SessionEmployee } from '../../src/backoffice/contracts/employee'

export type Call = {
  method: string
  path: string
  query: URLSearchParams
  idempotencyKey: string | null
  body: unknown
}

export type Reply = { status?: number; data?: unknown; error?: string }
type Handler = (call: Call) => Reply | Promise<Reply>

export type FakeServer = {
  calls: Call[]
  /** 后注册的优先：测试里可以临时覆盖某个接口。 */
  on: (method: string, path: string | RegExp, handler: Handler | Reply) => void
  callsTo: (method: string, path: string | RegExp) => Call[]
  restore: () => void
}

export function installFakeServer(): FakeServer {
  const original = globalThis.fetch
  const routes: { method: string; path: string | RegExp; handler: Handler }[] = []
  const calls: Call[] = []
  const matches = (pattern: string | RegExp, path: string) =>
    typeof pattern === 'string' ? pattern === path : pattern.test(path)

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    const call: Call = {
      method,
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      idempotencyKey: headers.get('Idempotency-Key'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    calls.push(call)
    const route = [...routes].reverse().find((r) => r.method === method && matches(r.path, call.path))
    const reply: Reply = route ? await route.handler(call) : { status: 500, error: 'NO_FAKE_ROUTE' }
    const status = reply.status ?? (reply.error ? 400 : 200)
    const envelope = reply.error
      ? { success: false, data: null, error: { code: reply.error, message: reply.error } }
      : { success: true, data: reply.data ?? null, error: null }
    return new Response(JSON.stringify(envelope), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return {
    calls,
    on(method, path, handler) {
      routes.push({ method, path, handler: typeof handler === 'function' ? handler : () => handler })
    },
    callsTo(method, path) {
      return calls.filter((c) => c.method === method && matches(path, c.path))
    },
    restore() {
      globalThis.fetch = original
    },
  }
}

/** 手动放行的响应：用来制造「请求还在路上时员工切走了」。 */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/* ---------------------------------- fixtures ---------------------------------- */

export const ALL_ACTIONS: AvailableActions = {
  claim: false,
  reply: true,
  internalNote: true,
  proposeResolution: true,
  tag: true,
  markRead: true,
}

export function row(id: string, patch: Partial<EnquiryRow> = {}): EnquiryRow {
  return {
    id,
    number: `HD-${id}`,
    subject: `Subject ${id}`,
    category: 'technical_support',
    status: 'ASSIGNED',
    locale: 'en-GB',
    learner: { id: `user-${id}`, email: `${id}@example.com`, name: `Learner ${id}` },
    contactEmail: null,
    preview: `Preview ${id}`,
    unreadByAgent: false,
    tags: [],
    needsReply: false,
    assignee: null,
    sequence: 1,
    createdAt: '2026-10-28T09:00:00Z',
    updatedAt: '2026-10-28T09:00:00Z',
    lastMessageAt: '2026-10-28T09:00:00Z',
    lastMessageBy: 'learner',
    ...patch,
  }
}

export function detail(id: string, patch: Partial<EnquiryDetail> = {}): EnquiryDetail {
  const base = row(id)
  return {
    ...base,
    student: {
      id: `user-${id}`,
      name: `Learner ${id}`,
      accountEmail: `${id}@example.com`,
      contactEmail: null,
      joinedAt: '2024-01-15T00:00:00Z',
      totalEnquiries: 3,
      currentCourse: { id: 'c1', title: 'A-level Maths' },
    },
    subscription: { planName: 'Premium', billingCycle: 'monthly', status: 'active', renewalDate: '2026-12-01T00:00:00Z' },
    messages: [
      {
        id: `${id}-m1`,
        authorKind: 'learner',
        authorName: '',
        body: `Body of ${id}`,
        internal: false,
        attachments: [],
        createdAt: '2026-10-28T09:00:00Z',
      },
    ],
    events: [],
    available: { ...ALL_ACTIONS },
    ...patch,
  }
}

export function question(id: string, patch: Partial<HelpdeskQuestion> = {}): HelpdeskQuestion {
  return {
    id,
    locale: 'en-GB',
    category: 'technical_support',
    question: `Question ${id}?`,
    answer: `Answer ${id}.`,
    keywords: [],
    status: 'published',
    featured: false,
    sortOrder: 1,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
    stats: { shown: 0, solved: 0, declined: 0 },
    ...patch,
  }
}

export function employee(role: SessionEmployee['role']): SessionEmployee {
  return {
    employeeId: 'emp-1',
    loginEmail: 'agent@example.com',
    role,
    displayName: 'Agent Smith',
    accountStatus: 'ACTIVE',
    emailVerification: 'VERIFIED',
    displayStatus: 'Active',
    isBootstrapAdmin: false,
  }
}

/**
 * 断言元素不存在。不要用 assert.equal(node, null)：失败时 node:assert 会 inspect 整个 jsdom 节点
 * （连带整棵文档与 window），内存会涨到 GB 级把进程拖死。
 */
export function absent(node: Element | null, message = 'expected the element to be absent'): void {
  if (node !== null) throw new Error(`${message}: found <${node.tagName.toLowerCase()}> "${node.textContent?.slice(0, 80)}"`)
}
