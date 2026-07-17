/**
 * Commedia code-names for agents, so each has a memorable identity you can
 * refer to ("Caronte hat den Endpoint gebaut"). Orchestrators draw from a
 * guides pool, subagents from a wilder cast pool.
 *
 * Each pool is shuffled as a bag: every name gets a turn in a random order
 * before the bag is refilled. Names remain unique among currently live agents.
 */
import { GUIDE_NAMES, CAST_NAMES } from '@shared/lore'

type AgentNameKind = 'orchestrator' | 'sub'
type RandomSource = () => number

const POOLS: Record<AgentNameKind, readonly string[]> = {
  orchestrator: GUIDE_NAMES,
  sub: CAST_NAMES
}

export class NameAllocator {
  private readonly taken = new Set<string>()
  private readonly bags: Record<AgentNameKind, string[]> = {
    orchestrator: [],
    sub: []
  }

  constructor(private readonly random: RandomSource = Math.random) {}

  private randomIndex(length: number): number {
    const sample = this.random()
    const normalized = Number.isFinite(sample)
      ? Math.max(0, Math.min(sample, 0.999_999_999_999_999_9))
      : 0
    return Math.floor(normalized * length)
  }

  private shuffle(values: readonly string[]): string[] {
    const shuffled = [...values]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = this.randomIndex(index + 1)
      ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
    }
    return shuffled
  }

  private drawFree(kind: AgentNameKind): string | undefined {
    let bag = this.bags[kind]
    while (bag.length > 0) {
      const candidate = bag.pop()!
      if (!this.taken.has(candidate)) return candidate
    }

    const free = POOLS[kind].filter((name) => !this.taken.has(name))
    if (free.length === 0) return undefined
    bag = this.shuffle(free)
    this.bags[kind] = bag
    return bag.pop()
  }

  allocate(kind: AgentNameKind): string {
    const free = this.drawFree(kind)
    if (free) {
      this.taken.add(free)
      return free
    }

    // Pool exhausted — keep the base-name order random for numbered fallbacks.
    const bases = this.shuffle(POOLS[kind])
    for (let suffix = 2; ; suffix += 1) {
      for (const base of bases) {
        const name = `${base} ${suffix}`
        if (!this.taken.has(name)) {
          this.taken.add(name)
          return name
        }
      }
    }
  }

  release(name: string): void {
    this.taken.delete(name)
  }
}
