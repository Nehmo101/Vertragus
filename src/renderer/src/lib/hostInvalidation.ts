import type { VertragusAppApi } from '../../../preload'

/** Coalesce host pushes without postponing refresh indefinitely during a busy run. */
export function followHostChanges(bridge: VertragusAppApi, refresh: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; refresh() }, 150)
  }
  const off = bridge.onWorkspaces(schedule)
  window.addEventListener('focus', schedule)
  return () => {
    off()
    window.removeEventListener('focus', schedule)
    clearTimeout(timer)
  }
}
