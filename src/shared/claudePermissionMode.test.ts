import { describe, expect, it } from 'vitest'
import {
  CLAUDE_PERMISSION_MODE_LABELS,
  CLAUDE_PERMISSION_MODES,
  claudePermissionModeArgs,
  claudePermissionModeSchema
} from './claudePermissionMode'

describe('claudePermissionModeArgs', () => {
  it('maps auto mode to acceptEdits', () => {
    expect(claudePermissionModeArgs('auto')).toEqual(['--permission-mode', 'acceptEdits'])
  })

  it('maps plan mode to the Claude plan permission mode', () => {
    expect(claudePermissionModeArgs('plan')).toEqual(['--permission-mode', 'plan'])
  })

  it('adds no arguments for default or an omitted mode', () => {
    expect(claudePermissionModeArgs('default')).toEqual([])
    expect(claudePermissionModeArgs()).toEqual([])
  })
})

describe('claudePermissionModeSchema', () => {
  it.each(CLAUDE_PERMISSION_MODES)('accepts %s', (mode) => {
    expect(claudePermissionModeSchema.parse(mode)).toBe(mode)
  })

  it('rejects unknown modes', () => {
    expect(claudePermissionModeSchema.safeParse('bypassPermissions').success).toBe(false)
  })

  it('provides a label for every mode', () => {
    for (const mode of CLAUDE_PERMISSION_MODES) {
      expect(CLAUDE_PERMISSION_MODE_LABELS[mode]).toBeTruthy()
    }
  })
})
