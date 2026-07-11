/**
 * Middle-earth code-names for agents, so each has a memorable identity you can
 * refer to ("Boromir hat den Endpoint gebaut"). Orchestrators draw from a
 * leaders pool, subagents from a fellowship pool. Names are handed out uniquely
 * among the currently live agents and returned to the pool when an agent ends.
 */
const LEADERS = [
  'Gandalf',
  'Aragorn',
  'Elrond',
  'Galadriel',
  'Théoden',
  'Faramir',
  'Boromir',
  'Círdan'
]

const FELLOWSHIP = [
  'Frodo',
  'Samweis',
  'Merry',
  'Pippin',
  'Legolas',
  'Gimli',
  'Éowyn',
  'Éomer',
  'Bilbo',
  'Radagast',
  'Glorfindel',
  'Haldir',
  'Bard',
  'Thorin',
  'Balin',
  'Dwalin',
  'Treebeard',
  'Beregond'
]

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
