#!/usr/bin/env node
/**
 * paste-tui — the smallest possible stand-in for a composer TUI, so the seed
 * handshake can be tested against a REAL pty instead of a fake snapshot.
 *
 * It does exactly what cursor-agent, Claude Code and every other full-screen
 * agent CLI do at the terminal-protocol level:
 *   - takes the keyboard in raw mode,
 *   - announces DECSET 2004 ("send me pastes bracketed"),
 *   - collects `ESC[200~ … ESC[201~` as literal text,
 *   - treats CR/LF outside those markers as the submitting keypress.
 *
 * Deliberately WITHOUT the timing heuristic real CLIs also carry ("that chunk
 * arrived too fast to be typing, treat it as a paste"). That heuristic is what
 * the old seed relied on, and relying on it is the bug: whether it fires
 * depends on how the pty happens to split the write. What this TUI pins is the
 * protocol guarantee underneath it, which does not depend on chunking at all.
 *
 * Usage:  node scripts/paste-tui.mjs
 * Output: `tui ready`, then one `SUBMIT <json>` line per submitted composer.
 */
const ESC = '\u001b'
const BRACKETED_PASTE_ON = `${ESC}[?2004h`
const PASTE_BEGIN = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write(BRACKETED_PASTE_ON)
process.stdout.write('tui ready\n')

let composer = ''
let pasting = false
let pending = ''

/** Length of the longest suffix of `s` that is a proper prefix of `marker`. */
function splitMarkerTail(s, marker) {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) {
    if (s.slice(-n) === marker.slice(0, n)) return n
  }
  return 0
}

process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8')
  for (;;) {
    const marker = pasting ? PASTE_END : PASTE_BEGIN
    const at = pending.indexOf(marker)
    if (at >= 0) {
      take(pending.slice(0, at))
      pending = pending.slice(at + marker.length)
      pasting = !pasting
      continue
    }
    // A marker can straddle two reads — hold back only that much.
    const held = splitMarkerTail(pending, marker)
    take(pending.slice(0, pending.length - held))
    pending = held ? pending.slice(-held) : ''
    return
  }
})

function take(text) {
  if (!text) return
  if (pasting) {
    composer += text
    return
  }
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') {
      process.stdout.write(`SUBMIT ${JSON.stringify(composer)}\n`)
      composer = ''
    } else composer += ch
  }
}
