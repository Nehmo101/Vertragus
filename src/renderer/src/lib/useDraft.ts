import { useId, useState, useSyncExternalStore } from 'react'

interface Entry<T> { value: T; revision: number }
const drafts = new Map<string, Entry<unknown>>()
const listeners = new Map<string, Set<() => void>>()
const pending = new Set<string>()

function read<T>(key: string, initial: T): Entry<T> {
  if (!drafts.has(key)) {
    let value = initial
    try {
      const stored = window.sessionStorage.getItem(key)
      if (stored !== null) value = JSON.parse(stored) as T
    } catch { /* Storage is optional. */ }
    drafts.set(key, { value, revision: 0 })
  }
  return drafts.get(key) as Entry<T>
}

/** Renderer-local drafts survive folded cards and question view remounts. */
export function useDraft<T>(key: string, initial: T): {
  value: T
  set: (value: T | ((previous: T) => T)) => void
  version: () => number
  clear: (version: number) => boolean
} {
  const storageKey = `vertragus.draft.${key}`
  const entry = useSyncExternalStore((notify) => {
    const subscriptions = listeners.get(storageKey) ?? new Set()
    subscriptions.add(notify)
    listeners.set(storageKey, subscriptions)
    return () => { subscriptions.delete(notify) }
  }, () => read(storageKey, initial), () => read(storageKey, initial))
  const set = (next: T | ((previous: T) => T)): void => {
    const current = read(storageKey, initial)
    const resolved = typeof next === 'function'
      ? (next as (previous: T) => T)(current.value)
      : next
    drafts.set(storageKey, { value: resolved, revision: current.revision + 1 })
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(resolved)) } catch { /* Storage is optional. */ }
    listeners.get(storageKey)?.forEach((notify) => notify())
  }
  return {
    value: entry.value, set,
    version: () => read(storageKey, initial).revision,
    clear: (version) => {
      if (read(storageKey, initial).revision !== version) return false
      set(initial)
      return true
    }
  }
}

/** One shared lock closes double-submit races between two views of a question. */
export function useSubmission(key?: string): {
  busy: boolean
  error: string | null
  run: (action: () => Promise<unknown>) => Promise<boolean>
} {
  const id = useId()
  const submissionKey = `submission.${key ?? id}`
  const busy = useSyncExternalStore((notify) => {
    const subscriptions = listeners.get(submissionKey) ?? new Set()
    subscriptions.add(notify)
    listeners.set(submissionKey, subscriptions)
    return () => { subscriptions.delete(notify) }
  }, () => pending.has(submissionKey), () => false)
  const [error, setError] = useState<string | null>(null)
  const setBusy = (value: boolean): void => {
    if (value) pending.add(submissionKey)
    else pending.delete(submissionKey)
    listeners.get(submissionKey)?.forEach((notify) => notify())
  }
  return {
    busy, error,
    run: async (action) => {
      if (pending.has(submissionKey)) return false
      setBusy(true)
      setError(null)
      try { await action(); return true } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return false
      } finally { setBusy(false) }
    }
  }
}
