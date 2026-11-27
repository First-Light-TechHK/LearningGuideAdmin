import { useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { createStore, useStore } from 'zustand'
import { EmployeeContext } from '../backoffice/employeeSession'

const prefix = 'backoffice.workspace.v1.'

function createWorkspace(owner?: string) {
  const namespace = owner ? prefix + encodeURIComponent(owner) + '.' : ''
  const initial: Record<string, unknown> = {}
  try {
    if (namespace) for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(namespace)) {
        try { initial[key.slice(namespace.length)] = JSON.parse(sessionStorage.getItem(key)!) } catch { /* incomplete entry */ }
      }
    }
  } catch { /* restricted browser storage: retain the in-memory workspace */ }
  const store = createStore(() => initial)
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    for (const key of pending) {
      const value = store.getState()[key]
      try {
        if (value === undefined) sessionStorage.removeItem(namespace + key)
        else sessionStorage.setItem(namespace + key, JSON.stringify(value))
      } catch { /* quota or private mode: keep the current session in memory */ }
    }
    pending.clear()
  }
  return {
    store, flush,
    saving: createStore<Record<string, boolean>>(() => ({})),
    read<T>(key: string) { return store.getState()[key] as T | undefined },
    write(key: string, value: unknown) {
      if (closed || store.getState()[key] === value) return
      store.setState({ [key]: value })
      if (namespace) {
        pending.add(key)
        timer ??= setTimeout(flush, 200)
      }
    },
    close() { closed = true; clearTimeout(timer); pending.clear(); store.setState({}, true) },
  }
}

const workspaces = new Map<string, ReturnType<typeof createWorkspace>>()
export function employeeWorkspace(owner: string) {
  let workspace = workspaces.get(owner)
  if (!workspace) { workspace = createWorkspace(owner); workspaces.set(owner, workspace) }
  return workspace
}

export function useWorkspace() {
  const owner = useContext(EmployeeContext)?.employeeId
  return useMemo(() => owner ? employeeWorkspace(owner) : createWorkspace(), [owner])
}

export function useWorkspaceValue<T>(workspace: ReturnType<typeof createWorkspace>, key: string) {
  return useStore(workspace.store, state => state[key] as T | undefined)
}

export function clearWorkspaceSessions() {
  for (const workspace of workspaces.values()) workspace.close()
  workspaces.clear()
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key)
  } catch { /* storage unavailable */ }
}

/** Restore after content is mounted. Store offsets without re-rendering on scroll. */
export function useWorkspaceScroll(workspace: ReturnType<typeof createWorkspace>, key: string, ready = true, element?: HTMLElement | null) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const target = element === undefined ? ref.current : element
    if (!ready || !target) return
    target.scrollTo?.({ top: workspace.read<number>(key) ?? 0 })
    const record = () => workspace.write(key, target.scrollTop)
    target.addEventListener('scroll', record, { passive: true })
    return () => target.removeEventListener('scroll', record)
  }, [workspace, key, ready, element])
  return ref
}
