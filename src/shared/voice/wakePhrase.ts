/**
 * Wake-phrase matching against noisy STT. Folding umlauts and allowing one
 * edit on long tokens exists so "Vertragvs" / "Grösse" still trigger; short
 * tokens stay exact so "fu0" does not become "funull".
 */

const FILLERS = new Set(['ok', 'hey', 'hi', 'hallo', 'bei'])

const UMLAUTS: Record<string, string> = {
  ä: 'a',
  ö: 'o',
  ü: 'u',
  ß: 'ss'
}

export function normalizeWake(text: string): string {
  const folded = text
    .toLowerCase()
    .replace(/[äöüß]/g, (ch) => UMLAUTS[ch] ?? ch)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return folded
}

export function matchWakePhrase(
  transcript: string,
  wakePhrase: string
): { hit: boolean; remainder: string } {
  const wakeTokens = tokenizeNormalized(wakePhrase)
  if (wakeTokens.length === 0) return { hit: false, remainder: '' }

  const stream = transcript
    .trim()
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeWake(raw) }))
    .filter((token) => token.norm.length > 0)

  if (stream.length < wakeTokens.length) return { hit: false, remainder: '' }

  const starts = [0]
  if (FILLERS.has(stream[0]!.norm)) starts.push(1)

  for (const start of starts) {
    if (start + wakeTokens.length > stream.length) continue
    if (!tokensMatchAt(stream, start, wakeTokens)) continue
    const remainder = stream
      .slice(start + wakeTokens.length)
      .map((token) => token.raw)
      .join(' ')
      .trim()
    return { hit: true, remainder }
  }

  return { hit: false, remainder: '' }
}

function tokenizeNormalized(text: string): string[] {
  const normalized = normalizeWake(text)
  return normalized.length === 0 ? [] : normalized.split(' ')
}

function tokensMatchAt(
  stream: readonly { norm: string }[],
  start: number,
  wakeTokens: readonly string[]
): boolean {
  for (let i = 0; i < wakeTokens.length; i += 1) {
    if (!tokenMatches(stream[start + i]!.norm, wakeTokens[i]!)) return false
  }
  return true
}

function tokenMatches(spoken: string, wake: string): boolean {
  if (spoken === wake) return true
  if (wake.length < 4) return false
  return levenshtein(spoken, wake) <= 1
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 1) return 2
  const rows = a.length + 1
  const cols = b.length + 1
  const prev = new Uint16Array(cols)
  const cur = new Uint16Array(cols)
  for (let j = 0; j < cols; j += 1) prev[j] = j
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i
    let rowMin = cur[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j < cols; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      const value = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      cur[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > 1) return 2
    prev.set(cur)
  }
  return prev[b.length]!
}
