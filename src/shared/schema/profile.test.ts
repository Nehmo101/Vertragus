import { describe, expect, it } from 'vitest'
import {
  createEmptyProfile,
  DEFAULT_PR_REMOTE,
  duplicateProfile,
  MAX_ROLE_PROMPTS,
  MAX_SLOTS,
  parseProfiles,
  profileRoleIds,
  profileSchema,
  ROLE_PROMPT_MAX_CHARS,
  rolePromptFor,
  roleTemplateSchema,
  slotLimitFor,
  slotSchema,
  type Profile
} from './profile'

function baseProfile(overrides: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    id: 'p1',
    name: 'Vertragus',
    repoPath: 'C:/git/vertragus',
    orchestrator: { providerId: 'claude', model: 'opus' },
    slots: [{ id: 's1', roleId: 'worker', providerId: 'codex', maxCount: 3 }],
    ...overrides
  })
}

describe('roleTemplateSchema', () => {
  it('defaults builtin to false and trims the name', () => {
    const parsed = roleTemplateSchema.parse({ id: 'qa', name: '  QA  ', prompt: 'Do QA.' })
    expect(parsed).toEqual({ id: 'qa', name: 'QA', prompt: 'Do QA.', builtin: false })
  })

  it('enforces the name and prompt bounds', () => {
    expect(roleTemplateSchema.safeParse({ id: 'x', name: 'x'.repeat(41), prompt: 'p' }).success).toBe(
      false
    )
    expect(roleTemplateSchema.safeParse({ id: 'x', name: 'x', prompt: '' }).success).toBe(false)
    expect(
      roleTemplateSchema.safeParse({ id: 'x', name: 'x', prompt: 'p'.repeat(8001) }).success
    ).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(
      roleTemplateSchema.safeParse({ id: 'x', name: 'x', prompt: 'p', color: '#fff' }).success
    ).toBe(false)
  })
})

describe('slotSchema', () => {
  it('keeps model and effort optional', () => {
    expect(slotSchema.parse({ id: 's', roleId: 'worker', providerId: 'claude' })).toEqual({
      id: 's',
      roleId: 'worker',
      providerId: 'claude'
    })
  })

  it('bounds maxCount to 1..16 and rejects a fractional count', () => {
    expect(slotSchema.safeParse({ id: 's', roleId: 'r', providerId: 'p', maxCount: 0 }).success).toBe(
      false
    )
    expect(slotSchema.safeParse({ id: 's', roleId: 'r', providerId: 'p', maxCount: 17 }).success).toBe(
      false
    )
    expect(slotSchema.safeParse({ id: 's', roleId: 'r', providerId: 'p', maxCount: 1.5 }).success).toBe(
      false
    )
  })

  it('rejects an unknown effort rung', () => {
    expect(
      slotSchema.safeParse({ id: 's', roleId: 'r', providerId: 'p', effort: 'ultra' }).success
    ).toBe(false)
  })

  it('E6: takes extra MCP servers with TOML-safe names and http urls', () => {
    const slot = slotSchema.parse({
      id: 's',
      roleId: 'r',
      providerId: 'p',
      extraMcp: [{ name: 'browser_tools', url: 'http://127.0.0.1:9200/mcp' }]
    })
    expect(slot.extraMcp).toEqual([{ name: 'browser_tools', url: 'http://127.0.0.1:9200/mcp' }])
  })

  it('E6: refuses the reserved name, unsafe names and non-urls', () => {
    const attempt = (entry: unknown): boolean =>
      slotSchema.safeParse({ id: 's', roleId: 'r', providerId: 'p', extraMcp: [entry] }).success
    // The reporting channel must be unshadowable, in any casing.
    expect(attempt({ name: 'vertragus', url: 'http://localhost:1/mcp' })).toBe(false)
    expect(attempt({ name: 'VERTRAGUS', url: 'http://localhost:1/mcp' })).toBe(false)
    // Names become Codex `-c mcp_servers.<name>` keys and Grok TOML tables.
    expect(attempt({ name: 'has space', url: 'http://localhost:1/mcp' })).toBe(false)
    expect(attempt({ name: 'dots.break.toml', url: 'http://localhost:1/mcp' })).toBe(false)
    expect(attempt({ name: 'browser', url: 'not a url' })).toBe(false)
  })
})

describe('profileSchema', () => {
  it('defaults repoPath and slots', () => {
    const parsed = profileSchema.parse({
      id: 'p',
      name: 'P',
      orchestrator: { providerId: 'claude' }
    })
    expect(parsed.repoPath).toBe('')
    expect(parsed.slots).toEqual([])
    expect(parsed.maxSubagents).toBeUndefined()
  })

  it('submits assignments automatically unless the profile opts out', () => {
    // The default is the whole point: a profile written before this field
    // existed — and every new one — must press Enter for the agent, because a
    // task parked in the composer is an agent that silently never starts.
    expect(baseProfile().autoSubmitTasks).toBe(true)
    expect(createEmptyProfile().autoSubmitTasks).toBe(true)
    expect(baseProfile({ autoSubmitTasks: false }).autoSubmitTasks).toBe(false)
    expect(
      profileSchema.safeParse({
        id: 'p',
        name: 'P',
        orchestrator: { providerId: 'c' },
        autoSubmitTasks: 'yes'
      }).success
    ).toBe(false)
  })

  it('A3: every automation switch is off for a profile that never named one', () => {
    // The default is the doctrine: adopting an agent's work and pushing a
    // branch stay the user's decision until the user says otherwise — and a
    // profile written before A3 said nothing at all.
    expect(baseProfile().automation).toEqual({
      autoIntegrate: false,
      autoPromote: false,
      autoPr: false,
      prRemote: DEFAULT_PR_REMOTE,
      prDraft: false
    })
    expect(createEmptyProfile().automation.autoPr).toBe(false)
  })

  it('A3: keeps the switches, the base branch and the remote it was given', () => {
    const profile = baseProfile({
      automation: {
        autoIntegrate: true,
        autoPromote: true,
        autoPr: true,
        prRemote: 'upstream',
        prBaseBranch: 'develop',
        prDraft: true
      }
    })
    expect(profile.automation).toMatchObject({
      autoIntegrate: true,
      autoPromote: true,
      autoPr: true,
      prRemote: 'upstream',
      prBaseBranch: 'develop',
      prDraft: true
    })
    expect(duplicateProfile(profile).automation.autoPr).toBe(true)
  })

  it('A3: rejects a malformed automation block instead of half-applying it', () => {
    expect(baseProfile.bind(null, { automation: { autoPr: 'yes' } })).toThrow()
    expect(baseProfile.bind(null, { automation: { prRemote: '' } })).toThrow()
    expect(baseProfile.bind(null, { automation: { unknownSwitch: true } })).toThrow()
  })

  it('carries the opt-out into a duplicate', () => {
    const copy = duplicateProfile(baseProfile({ autoSubmitTasks: false }))
    expect(copy.autoSubmitTasks).toBe(false)
  })

  it('enforces the name bounds and rejects unknown fields', () => {
    expect(profileSchema.safeParse({ id: 'p', name: '', orchestrator: { providerId: 'c' } }).success).toBe(
      false
    )
    expect(
      profileSchema.safeParse({ id: 'p', name: 'x'.repeat(61), orchestrator: { providerId: 'c' } })
        .success
    ).toBe(false)
    expect(
      profileSchema.safeParse({
        id: 'p',
        name: 'P',
        orchestrator: { providerId: 'c' },
        yoloDefault: true
      }).success
    ).toBe(false)
  })

  it('caps the slot list and maxSubagents', () => {
    const slots = Array.from({ length: MAX_SLOTS + 1 }, (_, index) => ({
      id: `s${index}`,
      roleId: 'worker',
      providerId: 'claude'
    }))
    expect(
      profileSchema.safeParse({ id: 'p', name: 'P', orchestrator: { providerId: 'c' }, slots }).success
    ).toBe(false)
    expect(
      profileSchema.safeParse({
        id: 'p',
        name: 'P',
        orchestrator: { providerId: 'c' },
        maxSubagents: 33
      }).success
    ).toBe(false)
  })

  it('accepts per-identity extra system prompts and looks them up by role id', () => {
    const profile = baseProfile({
      rolePrompts: [
        { roleId: 'orchestrator', prompt: '  Speak German.  ' },
        { roleId: 'worker', prompt: 'Three bullets.' }
      ]
    })
    expect(profile.rolePrompts).toEqual([
      { roleId: 'orchestrator', prompt: 'Speak German.' },
      { roleId: 'worker', prompt: 'Three bullets.' }
    ])
    expect(rolePromptFor(profile, 'orchestrator')).toBe('Speak German.')
    expect(rolePromptFor(profile, 'tester')).toBeUndefined()
    expect(rolePromptFor(undefined, 'worker')).toBeUndefined()
  })

  it('rejects a duplicate roleId, an empty prompt, and a prompt past the bound', () => {
    const raw = {
      id: 'p1',
      name: 'Vertragus',
      orchestrator: { providerId: 'claude' }
    }
    expect(
      profileSchema.safeParse({
        ...raw,
        rolePrompts: [
          { roleId: 'worker', prompt: 'A' },
          { roleId: 'worker', prompt: 'B' }
        ]
      }).success
    ).toBe(false)
    expect(
      profileSchema.safeParse({ ...raw, rolePrompts: [{ roleId: 'worker', prompt: '   ' }] }).success
    ).toBe(false)
    expect(
      profileSchema.safeParse({
        ...raw,
        rolePrompts: [{ roleId: 'worker', prompt: 'p'.repeat(ROLE_PROMPT_MAX_CHARS + 1) }]
      }).success
    ).toBe(false)
    expect(
      profileSchema.safeParse({
        ...raw,
        rolePrompts: Array.from({ length: MAX_ROLE_PROMPTS + 1 }, (_, index) => ({
          roleId: `r${index}`,
          prompt: 'x'
        }))
      }).success
    ).toBe(false)
  })

  it('carries extra prompts into a duplicate', () => {
    const copy = duplicateProfile(
      baseProfile({ rolePrompts: [{ roleId: 'tester', prompt: 'Be terse.' }] })
    )
    expect(copy.rolePrompts).toEqual([{ roleId: 'tester', prompt: 'Be terse.' }])
  })

  it('accepts an optional zone layout', () => {
    const parsed = baseProfile({
      zones: { zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }
    })
    expect(parsed.zones?.zones).toHaveLength(1)
  })
})

describe('parseProfiles', () => {
  it('keeps the valid rows and drops the rest', () => {
    const parsed = parseProfiles([
      { id: 'p1', name: 'One', orchestrator: { providerId: 'claude' } },
      { id: 'p2', name: '' },
      null,
      { id: 'p1', name: 'Duplicate', orchestrator: { providerId: 'claude' } }
    ])
    expect(parsed.map((profile) => profile.name)).toEqual(['One'])
  })

  it('returns nothing for a non-array store value', () => {
    expect(parseProfiles('{}')).toEqual([])
  })
})

describe('createEmptyProfile', () => {
  it('produces a schema-valid profile with no slots', () => {
    const profile = createEmptyProfile({ name: 'Fresh', repoPath: 'C:/tmp' })
    expect(profileSchema.safeParse(profile).success).toBe(true)
    expect(profile).toMatchObject({
      name: 'Fresh',
      repoPath: 'C:/tmp',
      orchestrator: { providerId: 'claude' },
      slots: []
    })
    expect(profile.id).toMatch(/^profile-/)
    expect(profile.rolePrompts?.map((entry) => entry.roleId).sort()).toEqual(
      [
        'architect',
        'docs',
        'explorer',
        'janitor',
        'lead',
        'orchestrator',
        'reviewer',
        'scout',
        'tester',
        'worker'
      ]
    )
  })

  it('gives two profiles created in a row different ids', () => {
    expect(createEmptyProfile().id).not.toBe(createEmptyProfile().id)
  })
})

describe('duplicateProfile', () => {
  it('creates an independent copy with a fresh id, name and slot ids', () => {
    const source = baseProfile()
    const copy = duplicateProfile(source, [source])
    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe('Vertragus (copy)')
    expect(copy.slots[0]!.id).not.toBe(source.slots[0]!.id)
    expect(copy.slots[0]!.roleId).toBe('worker')

    copy.slots[0]!.providerId = 'kimi'
    expect(source.slots[0]!.providerId).toBe('codex')
  })

  it('counts up when the copy name is taken', () => {
    const source = baseProfile()
    const existing = [source, baseProfile({ id: 'p2', name: 'Vertragus (copy)' })]
    expect(duplicateProfile(source, existing).name).toBe('Vertragus (copy 2)')
  })

  it('uses the caller-supplied word so the UI can localize it', () => {
    expect(duplicateProfile(baseProfile(), [], { copyWord: 'Kopie' }).name).toBe('Vertragus (Kopie)')
  })

  it('keepName reuses the original when it is free and still suffixes on a clash', () => {
    const source = baseProfile()
    expect(duplicateProfile(source, [], { keepName: true, copyWord: 'imported' }).name).toBe(
      'Vertragus'
    )
    expect(
      duplicateProfile(source, [source], { keepName: true, copyWord: 'imported' }).name
    ).toBe('Vertragus (imported)')
  })

  it('omitZones drops the layout so a portable copy cannot pin windows', () => {
    const source = baseProfile({
      zones: { zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }
    })
    expect(duplicateProfile(source).zones?.zones).toHaveLength(1)
    expect(duplicateProfile(source, [], { omitZones: true }).zones).toBeUndefined()
  })
})

describe('slotLimitFor', () => {
  it('reports an unconfigured role so start_agent can refuse it', () => {
    expect(slotLimitFor(baseProfile(), 'reviewer')).toEqual({ configured: false })
  })

  it('reports no cap when a slot leaves maxCount open', () => {
    const profile = baseProfile({
      slots: [{ id: 's1', roleId: 'worker', providerId: 'claude' }]
    })
    expect(slotLimitFor(profile, 'worker')).toEqual({ configured: true })
  })

  it('sums the caps of several slots of the same role', () => {
    const profile = baseProfile({
      slots: [
        { id: 's1', roleId: 'worker', providerId: 'claude', maxCount: 3 },
        { id: 's2', roleId: 'worker', providerId: 'codex', maxCount: 2 },
        { id: 's3', roleId: 'tester', providerId: 'codex', maxCount: 1 }
      ]
    })
    expect(slotLimitFor(profile, 'worker')).toEqual({ configured: true, max: 5 })
    expect(slotLimitFor(profile, 'tester')).toEqual({ configured: true, max: 1 })
  })

  it('never reports more than the global subagent ceiling', () => {
    const slots = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index}`,
      roleId: 'worker',
      providerId: 'claude',
      maxCount: 16
    }))
    expect(slotLimitFor(baseProfile({ slots }), 'worker')).toEqual({ configured: true, max: 32 })
  })
})

describe('profileRoleIds', () => {
  it('lists each staffed role once, in slot order', () => {
    const profile = baseProfile({
      slots: [
        { id: 's1', roleId: 'worker', providerId: 'claude' },
        { id: 's2', roleId: 'reviewer', providerId: 'codex' },
        { id: 's3', roleId: 'worker', providerId: 'kimi' }
      ]
    })
    expect(profileRoleIds(profile)).toEqual(['worker', 'reviewer'])
  })
})
