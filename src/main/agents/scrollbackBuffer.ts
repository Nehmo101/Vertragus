/**
 * Scrollback ring buffer for a single agent's PTY/headless output.
 *
 * Extracted from AgentManager so the buffer is independently testable and the
 * manager stays focused on lifecycle. Re-exported from AgentManager to preserve
 * the existing `@main/agents/AgentManager` import surface.
 */

export const BUFFER_LIMIT = 200_000 // chars of scrollback kept per agent

/**
 * PTY scrollback stored as an array of chunks with a running length instead of a
 * single immutable string. Appending is amortized O(chunk) (push + at most one
 * head trim) rather than O(BUFFER_LIMIT) — the previous `(buffer + data).slice(...)`
 * copied the full ~200 KB string on every PTY chunk. Tail reads (the hot per-chunk
 * scanners) join only the trailing chunks they need; the full flatten is memoized
 * and only paid by the infrequent full-buffer readers (handoff, resume sweep).
 */
export class ScrollbackBuffer {
  private chunks: string[] = []
  private total = 0
  private flat: string | undefined = ''

  constructor(private readonly limit: number = BUFFER_LIMIT, initial = '') {
    if (initial) this.append(initial)
  }

  append(data: string): void {
    if (!data) return
    this.chunks.push(data)
    this.total += data.length
    this.flat = undefined
    while (this.total > this.limit && this.chunks.length > 0) {
      const head = this.chunks[0]!
      const over = this.total - this.limit
      if (head.length <= over) {
        this.chunks.shift()
        this.total -= head.length
      } else {
        this.chunks[0] = head.slice(over)
        this.total -= over
      }
    }
  }

  /** Replace the entire scrollback (used for spawn-error placeholders). */
  reset(data = ''): void {
    this.chunks = data ? [data] : []
    this.total = data.length
    this.flat = data
  }

  get length(): number {
    return this.total
  }

  toString(): string {
    if (this.flat === undefined) this.flat = this.chunks.join('')
    return this.flat
  }

  /** Last `n` chars, joining only the trailing chunks needed (O(n), not O(total)). */
  tail(n: number): string {
    if (n <= 0) return ''
    if (n >= this.total) return this.toString()
    let acc = ''
    for (let i = this.chunks.length - 1; i >= 0 && acc.length < n; i--) {
      acc = this.chunks[i]! + acc
    }
    return acc.slice(-n)
  }
}
