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

function requiredOllamaModel(model: string | undefined): string {
  const selected = model?.trim()
  if (!selected) {
    throw new Error('Ollama benötigt ein explizit ausgewähltes lokales Modell.')
  }
  return selected
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

/** Keep Codex' full-screen TUI stable inside Orca's embedded terminal. */
export const CODEX_EMBEDDED_TUI_FLAGS = [
  '--no-alt-screen',
  '-c',
  'tui.animations=false'
] as const

/** Explicit safe-mode defaults instead of inheriting a potentially noisy user policy. */
export const CODEX_SAFE_INTERACTIVE_FLAGS = [
  '--sandbox',
  'workspace-write',
  '--ask-for-approval',
  'on-request',
  '-c',
  'approvals_reviewer=' + JSON.stringify('auto_review')
] as const

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
        args: [
          ...(opts.model ? ['--model', opts.model] : []),
          ...(opts.yolo ? yolo : CODEX_SAFE_INTERACTIVE_FLAGS),
          ...CODEX_EMBEDDED_TUI_FLAGS,
          ...extra
        ]
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
      return { command: 'ollama', args: ['run', requiredOllamaModel(opts.model), ...extra] }
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
        args: [
          'exec',
          ...(opts.model ? ['--model', opts.model] : []),
          // codex exec läuft immer non-interaktiv; --ask-for-approval wird ab codex-cli 0.144.x abgelehnt (exit 2)
          ...(opts.yolo
            ? YOLO_FLAGS.codex
            : [
                '--sandbox',
                'workspace-write',
                '-c',
                'approval_policy=' + JSON.stringify('never')
              ]),
          // Orchestrator workers are disposable; do not persist hundreds of one-shot chats.
          '--ephemeral',
          ...extra,
          prompt
        ]
      }
    case 'cursor':
      return {
        command: 'cursor-agent',
        args: [
          '-p',
          '--trust',
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
      return { command: 'ollama', args: ['run', requiredOllamaModel(opts.model)] }
  }
}
