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
 * arrived too fast to be typing, treat it as a paste") — except on Windows.
 * ConPTY converts host input to key events and drops CSI 200~/201~, so the
 * protocol this fixture exists to pin cannot be observed there. Real composer
 * CLIs then fall back to a burst heuristic; so does this TUI, only on win32,
 * so the seed handshake can still be measured against a real Windows pty.
 *
 * Usage:  node scripts/paste-tui.mjs
 * Output: `tui ready`, then one `SUBMIT <json>` line per submitted composer.
 */
const ESC = '\u001b'
const BRACKETED_PASTE_ON = `${ESC}[?2004h`
const PASTE_BEGIN = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`
const WIN = process.platform === 'win32'
/** Must stay below the seed handshake's submitDelayMs (100ms in the pty test). */
const WIN_BURST_MS = 40

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write(BRACKETED_PASTE_ON)
process.stdout.write('tui ready\n')

let composer = ''
let pasting = false
let pending = ''
let burstHold = null
let lastWasCR = false

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

function submitComposer() {
  burstHold = null
  lastWasCR = false
  process.stdout.write(`SUBMIT ${JSON.stringify(composer)}\n`)
  composer = ''
}

function take(text) {
  if (!text) return
  if (pasting) {
    flushHeldNewline()
    lastWasCR = false
    composer += text
    return
  }
  if (WIN) {
    takeWindowsBurst(text)
    return
  }
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') submitComposer()
    else composer += ch
  }
}

/**
 * ConPTY turns a multi-line write into key events: `\n` becomes Enter, and
 * paste markers never arrive. A CR/LF that is quickly followed by more text
 * is a line break of the assignment; one that sits alone is the submitting
 * Enter the handshake sends later.
 */
function takeWindowsBurst(text) {
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') {
      if (ch === '\n' && lastWasCR) {
        lastWasCR = false
        continue
      }
      lastWasCR = ch === '\r'
      flushHeldNewline()
      burstHold = setTimeout(submitComposer, WIN_BURST_MS)
    } else {
      lastWasCR = false
      flushHeldNewline()
      composer += ch
    }
  }
}

function flushHeldNewline() {
  if (!burstHold) return
  clearTimeout(burstHold)
  burstHold = null
  composer += '\n'
}
