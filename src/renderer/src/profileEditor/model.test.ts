import { describe, expect, it } from 'vitest'
import { profileSchema, ROLE_PROMPT_MAX_CHARS, type Profile } from '@shared/schema/profile'
import { BUILTIN_ROLE_TEMPLATES, roleColor } from '@shared/prompts/roles'
import { translator } from '../i18n'
import {
  CUSTOM_ROLE_VALUE,
  customRoleTemplate,
  draftFromProfile,
  emptyDraft,
  filterModelOptions,
  messageForPath,
  modelComboStatus,
  modelOptions,
  newSlotDraft,
  promptIdentities,
  roleOptions,
  toProfileInput,
  validateDraft,
  type ProfileDraft
} from './model'

/** The authored language — the assertions read as the real UI reads. */
const t = translator('de')
const en = translator('en')

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
    const result = validateDraft(t, draftFromProfile(SAVED))
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
    const result = validateDraft(t, draft({ autoSubmitTasks: false }))
    expect(result.ok && result.profile.autoSubmitTasks).toBe(false)
  })

  it('A3: carries every automation switch both ways, all off by default', () => {
    expect(emptyDraft('claude', 'profile-x').automation).toEqual({
      autoIntegrate: false,
      autoPromote: false,
      autoPr: false,
      prRemote: '',
      prBaseBranch: '',
      prDraft: false
    })

    const on = validateDraft(
      t,
      draft({
        automation: {
          autoIntegrate: true,
          autoPromote: false,
          autoPr: true,
          prRemote: '  upstream ',
          prBaseBranch: ' develop ',
          prDraft: true
        }
      })
    )
    expect(on.ok && on.profile.automation).toEqual({
      autoIntegrate: true,
      autoPromote: false,
      autoPr: true,
      prRemote: 'upstream',
      prBaseBranch: 'develop',
      prDraft: true
    })
  })

  it('A3: leaves the remote at the schema default instead of freezing today’s value', () => {
    // An empty remote field means "whatever origin means"; writing the
    // resolved default back would pin it into every profile ever edited.
    const input = toProfileInput(draft()) as { automation: Record<string, unknown> }
    expect('prRemote' in input.automation).toBe(false)
    expect('prBaseBranch' in input.automation).toBe(false)
    expect(draftFromProfile(SAVED).automation.prRemote).toBe('')
  })

  it('carries per-identity extra prompts both ways and omits blanks', () => {
    expect(emptyDraft('claude', 'profile-x').rolePrompts).toEqual({})
    expect(draftFromProfile(SAVED).rolePrompts).toEqual({})

    const filled = draft({
      rolePrompts: {
        orchestrator: '  Speak German.  ',
        worker: 'Three bullets.',
        tester: '   '
      }
    })
    const input = toProfileInput(filled) as { rolePrompts: Array<{ roleId: string; prompt: string }> }
    expect(input.rolePrompts).toEqual([
      { roleId: 'orchestrator', prompt: 'Speak German.' },
      { roleId: 'worker', prompt: 'Three bullets.' }
    ])

    const result = validateDraft(t, filled)
    expect(result.ok && result.profile.rolePrompts).toEqual([
      { roleId: 'orchestrator', prompt: 'Speak German.' },
      { roleId: 'worker', prompt: 'Three bullets.' }
    ])

    const roundTrip = draftFromProfile(
      profileSchema.parse({
        ...SAVED,
        rolePrompts: [{ roleId: 'lead', prompt: 'Stay in scope.' }]
      })
    )
    expect(roundTrip.rolePrompts).toEqual({ lead: 'Stay in scope.' })
    expect('rolePrompts' in (toProfileInput(draft({ rolePrompts: { worker: '' } })) as object)).toBe(
      false
    )
  })

  it('starts a new profile empty but valid apart from the repo path', () => {
    const fresh = emptyDraft('claude', 'profile-x')
    expect(fresh).toMatchObject({ id: 'profile-x', name: '', slots: [] })
    const result = validateDraft(t, { ...fresh, name: 'Neu' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(['repoPath'])
  })
})

describe('validation', () => {
  it('names the empty fields in German instead of leaking zod prose', () => {
    const result = validateDraft(t, draft({ name: '   ', repoPath: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.repoPath).toBe('Bitte den Repo-Ordner wählen.')
    expect(result.errors.name).toBe('Bitte einen Namen vergeben.')
  })

  it('rejects a slot cap that is not a usable number, keyed to that slot', () => {
    const result = validateDraft(t, 
      draft({
        slots: [
          { id: 's1', roleId: 'worker', providerId: 'claude', model: '', effort: '', maxCount: 'drei' }
        ]
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors['slots.0.maxCount']).toBe('Bitte eine Zahl ab 1 (oder leer lassen).')
  })

  it('A3: names the automation fields a user can get wrong instead of leaking zod prose', () => {
    const result = validateDraft(
      t,
      draft({
        automation: {
          autoIntegrate: false,
          autoPromote: false,
          autoPr: true,
          prRemote: '   x'.padEnd(400, 'x'),
          prBaseBranch: '',
          prDraft: false
        }
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors['automation.prRemote']).toBe(t('profileEditor.errors.prRemote'))
    }
  })

  it('rejects a maxSubagents beyond the schema bound', () => {
    const result = validateDraft(t, draft({ maxSubagents: '999' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.maxSubagents).toBeDefined()
  })

  it('names an overlong extra prompt instead of leaking zod prose', () => {
    const result = validateDraft(
      t,
      draft({
        rolePrompts: { worker: 'p'.repeat(ROLE_PROMPT_MAX_CHARS + 1) }
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors['rolePrompts.0.prompt']).toBe(
        'Bitte den Prompt unter 8000 Zeichen halten (oder leer lassen).'
      )
    }
  })

  it('maps unknown paths to one honest generic line', () => {
    expect(messageForPath(t, 'slots.2.providerId')).toBe('Bitte einen Provider wählen.')
    expect(messageForPath(t, 'slots.2.roleId')).toBe('Bitte eine Rolle wählen.')
    expect(messageForPath(t, 'rolePrompts.0.prompt')).toBe(
      'Bitte den Prompt unter 8000 Zeichen halten (oder leer lassen).'
    )
    expect(messageForPath(t, 'something.odd')).toBe('Ungültiger Wert.')
  })

  it('answers in the language it is handed', () => {
    const result = validateDraft(en, draft({ name: '   ', repoPath: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.repoPath).toBe('Please choose the repo folder.')
    expect(result.errors.name).toBe('Please enter a name.')
    expect(messageForPath(en, 'something.odd')).toBe('Invalid value.')
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

  it('lists Orchestrator and Lead ahead of every role template for extra prompts', () => {
    const identities = promptIdentities(BUILTIN_ROLE_TEMPLATES, roleColor)
    expect(identities[0]).toEqual({
      id: 'orchestrator',
      name: 'Orchestrator',
      color: roleColor('orchestrator')
    })
    expect(identities[1]).toEqual({ id: 'lead', name: 'Lead', color: roleColor('lead') })
    expect(identities.map((entry) => entry.id)).toEqual([
      'orchestrator',
      'lead',
      ...BUILTIN_ROLE_TEMPLATES.map((template) => template.id)
    ])
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

describe('filterModelOptions', () => {
  const options = ['auto', 'claude-opus-5', 'gpt-5.3-codex-high', 'kimi-code/k3']

  it('shows everything for an empty query', () => {
    expect(filterModelOptions(options, '   ')).toEqual(options)
  })

  it('matches on a substring, ignoring case and punctuation', () => {
    expect(filterModelOptions(options, 'OPUS')).toEqual(['claude-opus-5'])
    expect(filterModelOptions(options, 'opus5')).toEqual(['claude-opus-5'])
    expect(filterModelOptions(options, 'codexhigh')).toEqual(['gpt-5.3-codex-high'])
    expect(filterModelOptions(options, 'kimicode/k3')).toEqual(['kimi-code/k3'])
  })

  it('returns nothing for a typed id nobody offers — which stays typable', () => {
    expect(filterModelOptions(options, 'brand-new-model')).toEqual([])
  })
})

describe('modelComboStatus', () => {
  it('says it is still loading while discovery runs', () => {
    expect(modelComboStatus(t, undefined, true)).toMatchObject({ tone: 'loading' })
  })

  it('names the count and the source of a healthy list', () => {
    const status = modelComboStatus(
      t,
      { models: ['auto', 'composer-2.5'], source: 'live', refreshedAt: 0 },
      false
    )
    expect(status.tone).toBe('ok')
    expect(status.text).toBe('2 Modelle · live vom CLI')
  })

  it('warns — with the failing command — when nothing was found', () => {
    const status = modelComboStatus(
      t,
      {
        models: [],
        source: 'none',
        refreshedAt: 0,
        detail: 'cursor-agent models: spawn cursor-agent ENOENT'
      },
      false
    )
    expect(status.tone).toBe('warn')
    expect(status.text).toContain('Freitext')
    // The failing command is ON SCREEN, not only in the tooltip.
    expect(status.text).toContain('Quelle: cursor-agent models: spawn cursor-agent ENOENT')
    expect(status.title).toBe(status.text)
  })

  it('warns when only the seeded aliases are left, and shows why', () => {
    const status = modelComboStatus(
      t,
      {
        models: ['opus', 'sonnet', 'haiku'],
        source: 'seed',
        refreshedAt: 0,
        detail: '~/.claude.json: ENOENT'
      },
      false
    )
    expect(status.tone).toBe('warn')
    expect(status.text).toContain('Standard-Aliase des CLI')
    expect(status.text).toContain('~/.claude.json: ENOENT')
  })

  it('treats a seeded-plus-live list as healthy', () => {
    const status = modelComboStatus(
      t,
      { models: ['fable', 'claude-fable-5[1m]', 'opus'], source: 'mixed', refreshedAt: 0 },
      false
    )
    expect(status.tone).toBe('ok')
    expect(status.text).toBe('3 Modelle · live + Standard-Aliase')
    expect(
      modelComboStatus(
        en,
        { models: ['fable', 'claude-fable-5[1m]', 'opus'], source: 'mixed', refreshedAt: 0 },
        false
      ).text
    ).toBe('3 models · live + standard aliases')
  })

  it('does not claim to be loading once a provider answered with nothing', () => {
    expect(modelComboStatus(t, undefined, false).tone).toBe('warn')
  })
})
