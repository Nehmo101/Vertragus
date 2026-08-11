import { describe, expect, it } from 'vitest'
import { profileSchema, type Profile } from '@shared/schema/profile'
import { BUILTIN_ROLE_TEMPLATES, roleColor } from '@shared/prompts/roles'
import {
  CUSTOM_ROLE_VALUE,
  customRoleTemplate,
  draftFromProfile,
  emptyDraft,
  messageForPath,
  modelOptions,
  newSlotDraft,
  roleOptions,
  toProfileInput,
  validateDraft,
  type ProfileDraft
} from './model'

const SAVED: Profile = profileSchema.parse({
  id: 'p1',
  name: 'Vertragus',
  repoPath: 'C:/git/vertragus',
  orchestrator: { providerId: 'claude', model: 'opus', effort: 'high' },
  slots: [
    { id: 's1', roleId: 'worker', providerId: 'codex', model: 'gpt-5.6', maxCount: 3 },
    { id: 's2', roleId: 'reviewer', providerId: 'claude' }
  ],
  maxSubagents: 4
})

function draft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return { ...draftFromProfile(SAVED), ...overrides }
}

describe('draft ⇄ profile', () => {
  it('round-trips a saved profile without changing a single value', () => {
    const result = validateDraft(draftFromProfile(SAVED))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.profile).toEqual(SAVED)
  })

  it('turns empty optional fields into absent ones, never into empty strings', () => {
    const input = toProfileInput(
      draft({
        orchestrator: { providerId: 'claude', model: '   ', effort: '' },
        slots: [{ id: 's1', roleId: 'worker', providerId: 'claude', model: '', effort: '', maxCount: '' }],
        maxSubagents: ''
      })
    ) as Record<string, unknown>

    expect(input.orchestrator).toEqual({ providerId: 'claude' })
    expect(input.slots).toEqual([{ id: 's1', roleId: 'worker', providerId: 'claude' }])
    expect('maxSubagents' in input).toBe(false)
  })

  it('trims the text fields on the way out', () => {
    const input = toProfileInput(draft({ name: '  Terra  ', repoPath: '  C:/git/terra  ' })) as {
      name: string
      repoPath: string
    }
    expect(input).toMatchObject({ name: 'Terra', repoPath: 'C:/git/terra' })
  })

  it('keeps a zone layout the editor does not touch', () => {
    const zones = { zones: [] }
    const input = toProfileInput(draft({ zones })) as Record<string, unknown>
    expect(input.zones).toBe(zones)
  })

  it('carries the auto-submit switch both ways, on by default', () => {
    expect(emptyDraft('claude', 'profile-x').autoSubmitTasks).toBe(true)
    expect(draftFromProfile(SAVED).autoSubmitTasks).toBe(true)

    // Off must survive the round trip as `false`, not as an omitted field: an
    // omission would fall back to the schema default and silently re-arm it.
    const off = toProfileInput(draft({ autoSubmitTasks: false })) as Record<string, unknown>
    expect(off.autoSubmitTasks).toBe(false)
    const result = validateDraft(draft({ autoSubmitTasks: false }))
    expect(result.ok && result.profile.autoSubmitTasks).toBe(false)
  })

  it('starts a new profile empty but valid apart from the repo path', () => {
    const fresh = emptyDraft('claude', 'profile-x')
    expect(fresh).toMatchObject({ id: 'profile-x', name: '', slots: [] })
    const result = validateDraft({ ...fresh, name: 'Neu' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(['repoPath'])
  })
})

describe('validation', () => {
  it('names the empty fields in German instead of leaking zod prose', () => {
    const result = validateDraft(draft({ name: '   ', repoPath: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.repoPath).toBe('Bitte den Repo-Ordner wählen.')
    expect(result.errors.name).toBe('Bitte einen Namen vergeben.')
  })

  it('rejects a slot cap that is not a usable number, keyed to that slot', () => {
    const result = validateDraft(
      draft({
        slots: [
          { id: 's1', roleId: 'worker', providerId: 'claude', model: '', effort: '', maxCount: 'drei' }
        ]
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors['slots.0.maxCount']).toBe('Bitte eine Zahl ab 1 (oder leer lassen).')
  })

  it('rejects a maxSubagents beyond the schema bound', () => {
    const result = validateDraft(draft({ maxSubagents: '999' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.maxSubagents).toBeDefined()
  })

  it('maps unknown paths to one honest generic line', () => {
    expect(messageForPath('slots.2.providerId')).toBe('Bitte einen Provider wählen.')
    expect(messageForPath('slots.2.roleId')).toBe('Bitte eine Rolle wählen.')
    expect(messageForPath('something.odd')).toBe('Ungültiger Wert.')
  })
})

describe('pickers', () => {
  it('offers every discovered spelling, snapshots included', () => {
    expect(
      modelOptions(['claude-opus-5', 'claude-opus-5-20250929', 'opus', 'claude-opus-5'])
      // the dated snapshot stays reachable, folded under the id it belongs to
    ).toEqual(['claude-opus-5', 'claude-opus-5-20250929', 'opus'])
    expect(modelOptions([])).toEqual([])
  })

  it('lists the role templates with their accent colour', () => {
    const options = roleOptions(BUILTIN_ROLE_TEMPLATES, roleColor)
    expect(options[0]).toEqual({ id: 'worker', name: 'Worker', color: roleColor('worker', 0) })
    expect(options).toHaveLength(BUILTIN_ROLE_TEMPLATES.length)
    expect(CUSTOM_ROLE_VALUE).not.toBe('')
  })

  it('builds a fresh slot and a custom role template', () => {
    const slot = newSlotDraft('reviewer', 'codex', 'slot-x')
    expect(slot).toEqual({
      id: 'slot-x',
      roleId: 'reviewer',
      providerId: 'codex',
      model: '',
      effort: '',
      maxCount: ''
    })

    const role = customRoleTemplate('  Bugjäger  ', '  Find bugs.  ', 'role-x')
    expect(role).toEqual({ id: 'role-x', name: 'Bugjäger', prompt: 'Find bugs.', builtin: false })
  })
})
