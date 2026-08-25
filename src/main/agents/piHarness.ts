/**
 * Pi harness wrap — not a provider preset.
 *
 * When the wrap is on, Vertragus still names the slot Claude / Cursor / Codex
 * (model route and subscription). The process that actually starts is `pi`,
 * with `--provider` mapped from the slot's preset and `--model` from the
 * slot's model. Native CLIs (`claude`, `cursor-agent`, …) are not spawned.
 *
 * MCP still has to attach: Pi has no built-in MCP, so we load the community
 * adapter `npm:pi-mcp-adapter` and write `.pi/mcp.json` in the worktree.
 * Pi's `--tools` allowlist can hide MCP tools, so v1 does not restrict it.
 *
 * Flags come from the published CLI
 * (https://pi.dev/docs/latest/usage): `--no-session`, `--approve`,
 * `--no-extensions`, `-e`, `--provider`, `--model`, `--thinking`,
 * `--append-system-prompt`. Pi has no permission prompts — native yolo
 * flags are not forwarded.
 */
import type { EffortLevel } from '@shared/schema/provider'

/** The binary on PATH. Install: `npm i -g --ignore-scripts @mariozechner/pi-coding-agent`. */
export const PI_HARNESS_COMMAND = 'pi'

/**
 * Community MCP adapter, loaded as the only extension so host discovery of
 * Cursor/Claude project files cannot shadow the per-agent Vertragus URL.
 */
export const PI_MCP_ADAPTER_EXTENSION = 'npm:pi-mcp-adapter'

/**
 * Map a Vertragus preset id onto Pi's `--provider`. `undefined` means omit
 * the flag and pass `--model` only (custom slots, Ollama — llama.cpp is not
 * in Pi's published catalogue).
 *
 * Cursor → `github-copilot` is the closest published backend; the Cursor CLI
 * itself is not a Pi provider. Documented, not papered over.
 */
export function piProviderFor(presetId: string | undefined): string | undefined {
  switch (presetId) {
    case 'claude':
      return 'anthropic'
    case 'codex':
      return 'openai-codex'
    case 'kimi':
      return 'kimi-coding'
    case 'cursor':
      return 'github-copilot'
    case 'grok':
      return 'xai'
    default:
      return undefined
  }
}

/**
 * Vertragus effort is `low|medium|high`, which Pi's `--thinking` accepts
 * verbatim. Absent effort → omit the flag (Pi's own default).
 */
export function piThinkingFor(effort: EffortLevel | undefined): string | undefined {
  return effort
}

export interface PiHarnessArgvInput {
  presetId?: string
  model?: string
  effort?: EffortLevel
  systemPrompt?: string
  initialPrompt?: string
}

/**
 * Pure argv for one Pi wrap. The caller writes `.pi/mcp.json` first; this
 * function never touches the disk and never consults `provider.args` —
 * Ollama's `run --nowordwrap` would break Pi if it leaked through.
 */
export function buildPiHarnessArgv(input: PiHarnessArgvInput): string[] {
  const argv = [
    '--no-session',
    '--approve',
    '--no-extensions',
    '-e',
    PI_MCP_ADAPTER_EXTENSION
  ]
  const provider = piProviderFor(input.presetId)
  if (provider) argv.push('--provider', provider)
  const model = input.model?.trim()
  if (model) argv.push('--model', model)
  const thinking = piThinkingFor(input.effort)
  if (thinking) argv.push('--thinking', thinking)
  const prompt = input.systemPrompt?.trim()
  if (prompt) argv.push('--append-system-prompt', prompt)
  const initial = input.initialPrompt?.trim()
  if (initial) argv.push(initial)
  return argv
}
