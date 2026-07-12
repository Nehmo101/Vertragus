/**
 * Provider adapter contract + command-building helpers.
 *
 * Phase 0 ships the pure, testable command construction (interactive args,
 * headless args, Yolo flags). Phase 1 wires spawnInteractive() to node-pty and
 * runHeadless() to stream-json parsing.
 */
import type { AgentProviderId } from '@shared/providers'

export interface SpawnOpts {
  model?: string
  workingDir: string
  yolo: boolean
  /** Extra provider-specific args appended verbatim. */
  extraArgs?: string[]
}

export interface HeadlessOpts extends SpawnOpts {
  /** Appended to the provider's default system prompt where supported. */
  systemPrompt?: string
}

/** Command + args ready to hand to node-pty / child_process. */
export interface Launch {
  command: string
  args: string[]
}

/**
 * Yolo (auto-approve) flags per provider — verified against each CLI's --help
 * (copilot per the public @github/copilot CLI). ollama has no permission layer.
 */
export const YOLO_FLAGS: Record<AgentProviderId, string[]> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  cursor: ['--yolo'],
  copilot: ['--allow-all-tools'],
  ollama: []
}

export function buildInteractiveLaunch(id: AgentProviderId, opts: SpawnOpts): Launch {
  const yolo = opts.yolo ? YOLO_FLAGS[id] : []
  const extra = opts.extraArgs ?? []
  switch (id) {
    case 'claude':
      return {
        command: 'claude',
        args: [...(opts.model ? ['--model', opts.model] : []), ...yolo, ...extra]
      }
    case 'codex':
      return {
        command: 'codex',
        args: [...(opts.model ? ['-c', `model=${opts.model}`] : []), ...yolo, ...extra]
      }
    case 'cursor':
      return {
        command: 'cursor-agent',
        args: [...(opts.model ? ['--model', opts.model] : []), ...yolo, ...extra]
      }
    case 'copilot':
      // Bare `copilot` launches the interactive agent TUI in the working dir.
      return {
        command: 'copilot',
        args: [...(opts.model ? ['--model', opts.model] : []), ...yolo, ...extra]
      }
    case 'ollama':
      return { command: 'ollama', args: ['run', opts.model ?? 'llama3', ...extra] }
  }
}

/** Non-interactive launch used by the orchestrator to dispatch a single task. */
export function buildHeadlessLaunch(
  id: AgentProviderId,
  prompt: string,
  opts: HeadlessOpts
): Launch {
  const yolo = opts.yolo ? YOLO_FLAGS[id] : []
  const extra = opts.extraArgs ?? []
  switch (id) {
    case 'claude':
      return {
        command: 'claude',
        args: [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
          ...(opts.model ? ['--model', opts.model] : []),
          ...(opts.systemPrompt ? ['--append-system-prompt', opts.systemPrompt] : []),
          ...yolo,
          ...extra
        ]
      }
    case 'codex':
      return {
        command: 'codex',
        args: ['exec', prompt, ...(opts.model ? ['-c', `model=${opts.model}`] : []), ...yolo, ...extra]
      }
    case 'cursor':
      return {
        command: 'cursor-agent',
        args: [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
          ...(opts.model ? ['--model', opts.model] : []),
          ...yolo,
          ...extra
        ]
      }
    case 'copilot':
      // `-p` runs a single prompt non-interactively and streams plain text to
      // stdout (no JSON envelope) — runHeadless's non-JSON path handles it.
      return {
        command: 'copilot',
        args: ['-p', prompt, ...(opts.model ? ['--model', opts.model] : []), ...yolo, ...extra]
      }
    case 'ollama':
      // ollama is driven via its HTTP API in runHeadless(); no CLI launch here.
      return { command: 'ollama', args: ['run', opts.model ?? 'llama3'] }
  }
}
