/**
 * Middle-earth code-names for agents, so each has a memorable identity you can
 * refer to ("Boromir hat den Endpoint gebaut"). Orchestrators draw from a
 * leaders pool, subagents from a wilder fellowship pool. Names are handed out
 * uniquely among the currently live agents and returned to the pool when an
 * agent ends. The cast (and the hover tooltips that explain each figure) live
 * in the shared `tolkien` module.
 */
import { LEADER_NAMES, FELLOWSHIP_NAMES } from '@shared/tolkien'

const LEADERS = LEADER_NAMES
const FELLOWSHIP = FELLOWSHIP_NAMES

export class NameAllocator {
  private readonly taken = new Set<string>()

  allocate(kind: 'orchestrator' | 'sub'): string {
    const pool = kind === 'orchestrator' ? LEADERS : FELLOWSHIP
    const free = pool.find((n) => !this.taken.has(n))
    if (free) {
      this.taken.add(free)
      return free
    }
    // Pool exhausted — suffix a number on a base name.
    let i = 2
    for (;;) {
      const name = `${pool[(i - 2) % pool.length]} ${i}`
      if (!this.taken.has(name)) {
        this.taken.add(name)
        return name
      }
      i++
    }
  }

  release(name: string): void {
    this.taken.delete(name)
  }
}
