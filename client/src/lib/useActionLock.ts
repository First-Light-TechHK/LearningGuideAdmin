import { useRef, useState } from 'react'

export function useActionLock() {
  const locks = useRef(new Map<string, symbol>())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  const acquire = (key = '') => {
    if (locks.current.has(key)) return null
    const token = Symbol()
    locks.current.set(key, token)
    setPending(new Set(locks.current.keys()))
    return () => {
      if (locks.current.get(key) !== token) return
      locks.current.delete(key)
      setPending(new Set(locks.current.keys()))
    }
  }

  return { acquire, pending, isLocked: (key = '') => locks.current.has(key) }
}
