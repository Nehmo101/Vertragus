import { z } from 'zod'

export const CLAUDE_PERMISSION_MODES = ['default', 'auto', 'plan'] as const

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]

export const claudePermissionModeSchema = z.enum(CLAUDE_PERMISSION_MODES)

export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'default'

export const CLAUDE_PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
  default: 'Standard (Nachfragen)',
  auto: 'Auto-Mode (Edits automatisch bestätigen)',
  plan: 'Plan-Mode (nur planen)'
}

export function claudePermissionModeArgs(mode?: ClaudePermissionMode): string[] {
  switch (mode) {
    case 'auto':
      return ['--permission-mode', 'acceptEdits']
    case 'plan':
      return ['--permission-mode', 'plan']
    default:
      return []
  }
}
