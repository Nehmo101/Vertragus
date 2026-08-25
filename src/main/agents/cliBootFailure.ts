/**
 * Diagnose a CLI that died (or hung dead) during the seed handshake.
 *
 * The handshake's boolean is "the prompt was delivered to a live TUI". When
 * that is false the panel used to say only "never became ready", which hid
 * the one sentence the CLI did print — on Windows that is often Windows
 * Smart App Control / WDAC / AppLocker blocking an unsigned `.node` addon
 * under `%LOCALAPPDATA%\cursor-agent\`. Vertragus cannot override that
 * policy; it can name it instead of waiting out the keyboard timeout and
 * then blaming the seed.
 *
 * Detection is output-shaped, not provider-shaped: the same dump shows up
 * for Cursor Agent and would for any other Node CLI that loads a blocked
 * native binding. The idle heuristic must not treat the crash dump as a
 * "quiet banner" and paste into it — {@link isFatalCliBootOutput} is the
 * gate the handshake consults on every poll.
 */
import { mainMessages } from '@shared/mainMessages'
import { normalizeTerminalChunk } from '@main/workspace/terminalText'

export type SeedFailurePurpose = 'orchestrator-prompt' | 'task' | 'area'

export interface CliBootDiagnosis {
  kind: 'application-control' | 'output'
  /** Absolute path of the blocked `.node` file, when the dump named one. */
  blockedPath?: string
  /** ANSI-stripped tail of the PTY, for the panel banner. */
  excerpt: string
}

/**
 * Measured against cursor-agent 2026.08.11-e8db854 on Windows 11 with Smart
 * App Control on. The same `node-loader` / `Application Control policy`
 * sentence appears for other unsigned addons in the same install
 * (`merkle-tree-napi`, `node_sqlite3`).
 */
const APP_CONTROL_POLICY = /Application Control policy has blocked this file/i
const NODE_LOADER = /node-loader:/i
const NATIVE_BINDING = /Failed to load native binding/i
const WIN_NODE_PATH = /[A-Za-z]:\\[^\r\n"'<>|*?]+\.node/i
const POSIX_NODE_PATH = /\/[^\s"'<>|*?]+\.node\b/

/** Bytes of stripped scrollback worth quoting in an error. */
const EXCERPT_MAX = 500
/** Shorter than this is a test banner (`ready> `), not a crash dump. */
const EXCERPT_MIN = 40

/**
 * True when the PTY already shows a boot that cannot become a TUI — pasting
 * the assignment would only bury the dump. Alive-but-stuck counts: the
 * process may sit at the node-loader error with a cursor instead of exiting.
 */
export function isFatalCliBootOutput(buffer: string): boolean {
  return APP_CONTROL_POLICY.test(buffer) || NODE_LOADER.test(buffer) || NATIVE_BINDING.test(buffer)
}

export function diagnoseCliBootFailure(buffer: string): CliBootDiagnosis | undefined {
  const excerpt = bootExcerpt(buffer)
  if (isFatalCliBootOutput(buffer)) {
    const blockedPath = blockedNativePath(buffer)
    if (APP_CONTROL_POLICY.test(buffer) || (NODE_LOADER.test(buffer) && blockedPath)) {
      return { kind: 'application-control', ...(blockedPath ? { blockedPath } : {}), excerpt }
    }
    if (!excerpt) return { kind: 'output', excerpt: strippedHead(buffer) }
    return { kind: 'output', excerpt }
  }
  if (!excerpt) return undefined
  return { kind: 'output', excerpt }
}

export function formatSeedFailure(input: {
  name: string
  providerLabel: string
  purpose: SeedFailurePurpose
  buffer: string
  locale?: string
}): string {
  const messages = mainMessages(input.locale)
  const diagnosis = diagnoseCliBootFailure(input.buffer)
  if (diagnosis?.kind === 'application-control') {
    return messages.cliBlockedByAppControl(
      input.name,
      input.providerLabel,
      diagnosis.blockedPath ?? messages.cliNativeAddon
    )
  }
  const base =
    input.purpose === 'orchestrator-prompt'
      ? messages.cliNeverReadyPrompt(input.name, input.providerLabel)
      : input.purpose === 'task'
        ? messages.cliNeverReadyTask(input.name, input.providerLabel)
        : messages.cliNeverReadyArea(input.name, input.providerLabel)
  if (diagnosis?.excerpt) return `${base}\n\n${messages.cliOutputExcerpt(diagnosis.excerpt)}`
  return base
}

function blockedNativePath(buffer: string): string | undefined {
  const text = normalizeTerminalChunk(buffer)
  return text.match(WIN_NODE_PATH)?.[0] ?? text.match(POSIX_NODE_PATH)?.[0]
}

function bootExcerpt(buffer: string): string {
  const cleaned = normalizeTerminalChunk(buffer)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (cleaned.length < EXCERPT_MIN) return ''
  return cleaned.length > EXCERPT_MAX ? cleaned.slice(-EXCERPT_MAX) : cleaned
}

/** Last-resort quote when the dump matched a fatal pattern but stripped to nothing. */
function strippedHead(buffer: string): string {
  const cleaned = normalizeTerminalChunk(buffer).trim()
  return cleaned.slice(0, EXCERPT_MAX) || 'native addon failed to load'
}
