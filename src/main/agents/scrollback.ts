/**
 * Scrollback ring buffer for a single agent's PTY output.
 *
 * Ported in substance from the old repo's ScrollbackBuffer: chunks plus a
 * running length instead of one immutable string, so appending stays
 * amortized O(chunk) instead of copying the whole buffer on every PTY tick.
 *
 * Two consumers depend on it:
 *  - the CLI window's late attach (`terminal:attach` replays `snapshot()`),
 *  - `read_output` in M2 (ANSI-cleaned tail of the same buffer).
 */

/** Characters of scrollback kept per agent (~2 MB of UTF-16 text). */
export const SCROLLBACK_LIMIT = 2_000_000

export class ScrollbackBuffer {
  private chunks: string[] = []
  private total = 0
  private flat: string | undefined = ''

  constructor(private readonly limit: number = SCROLLBACK_LIMIT) {}

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

  /** Replace the whole scrollback (spawn-error placeholders). */
  reset(data = ''): void {
    this.chunks = data ? [data] : []
    this.total = data.length
    this.flat = data
  }

  get length(): number {
    return this.total
  }

  /** Everything still held, memoized until the next append. */
  snapshot(): string {
    if (this.flat === undefined) this.flat = this.chunks.join('')
    return this.flat
  }

  /** Last `n` characters, joining only the trailing chunks needed. */
  tail(n: number): string {
    if (n <= 0) return ''
    if (n >= this.total) return this.snapshot()
    let acc = ''
    for (let i = this.chunks.length - 1; i >= 0 && acc.length < n; i--) {
      acc = this.chunks[i]! + acc
    }
    return acc.slice(-n)
  }
}
