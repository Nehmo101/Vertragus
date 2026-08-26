import { describe, expect, it } from 'vitest'
import { profileSchema, type Profile, type RoleTemplate } from './profile'
import {
  PROFILE_BUNDLE_KIND,
  PROFILE_BUNDLE_VERSION,
  adoptRoleTemplates,
  ensureJsonExtension,
  importProfileFromBundle,
  isShippedRoleId,
  packProfileBundle,
  parseProfileBundleText,
  referencedCustomRoleIds,
  serializeProfileBundle,
  suggestedProfileFilename
} from './profileBundle'

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

const qa: RoleTemplate = {
  id: 'qa',
  name: 'QA',
  prompt: 'Find bugs.',
  builtin: false
}

describe('isShippedRoleId', () => {
  it('treats built-ins and the reserved identities as shipped', () => {
    expect(isShippedRoleId('worker')).toBe(true)
    expect(isShippedRoleId('orchestrator')).toBe(true)
    expect(isShippedRoleId('lead')).toBe(true)
    expect(isShippedRoleId('qa')).toBe(false)
  })
})

describe('packProfileBundle', () => {
  it('strips zones and keeps prompts, playbooks, automation and extra MCP', () => {
    const profile = baseProfile({
      rolePrompts: [{ roleId: 'worker', prompt: 'Three bullets.' }],
      playbooks: [{ name: 'Fix', goal: 'Fix the login.' }],
      automation: { autoIntegrate: true },
      slots: [
        {
          id: 's1',
          roleId: 'worker',
          providerId: 'codex',
          extraMcp: [{ name: 'browser_tools', url: 'http://127.0.0.1:9200/mcp' }]
        }
      ],
      zones: { zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }
    })
    const bundle = packProfileBundle(profile, [qa])
    expect(bundle.kind).toBe(PROFILE_BUNDLE_KIND)
    expect(bundle.version).toBe(PROFILE_BUNDLE_VERSION)
    expect(bundle.profile.zones).toBeUndefined()
    expect(bundle.profile.rolePrompts).toEqual([{ roleId: 'worker', prompt: 'Three bullets.' }])
    expect(bundle.profile.playbooks).toEqual([{ name: 'Fix', goal: 'Fix the login.' }])
    expect(bundle.profile.automation.autoIntegrate).toBe(true)
    expect(bundle.profile.slots[0]!.extraMcp).toEqual([
      { name: 'browser_tools', url: 'http://127.0.0.1:9200/mcp' }
    ])
    expect(bundle.roleTemplates).toEqual([])
  })

  it('includes only the custom roles the profile actually uses', () => {
    const unused: RoleTemplate = { id: 'docs-writer', name: 'Docs', prompt: 'Write.', builtin: false }
    const profile = baseProfile({
      slots: [{ id: 's1', roleId: 'qa', providerId: 'claude' }],
      rolePrompts: [{ roleId: 'qa', prompt: 'Be terse.' }]
    })
    const bundle = packProfileBundle(profile, [qa, unused])
    expect(bundle.roleTemplates).toEqual([qa])
    expect(referencedCustomRoleIds(profile)).toEqual(new Set(['qa']))
  })

  it('never packs a built-in override as a custom template', () => {
    const workerOverride: RoleTemplate = {
      id: 'worker',
      name: 'Worker',
      prompt: 'Do not ship this globally.',
      builtin: true
    }
    const bundle = packProfileBundle(baseProfile(), [workerOverride])
    expect(bundle.roleTemplates).toEqual([])
  })
})

describe('parseProfileBundleText', () => {
  it('round-trips a packed envelope and still drops zones smuggled into the file', () => {
    const packed = packProfileBundle(
      baseProfile({
        rolePrompts: [{ roleId: 'tester', prompt: 'Be terse.' }]
      })
    )
    const smuggled = {
      ...packed,
      profile: {
        ...packed.profile,
        zones: { zones: [{ roleId: 'worker', displayId: 9, rect: { x: 0, y: 0, w: 0.4, h: 0.4 } }] }
      }
    }
    const parsed = parseProfileBundleText(JSON.stringify(smuggled))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.profile.rolePrompts).toEqual([{ roleId: 'tester', prompt: 'Be terse.' }])
    expect(parsed.bundle.profile.zones).toBeUndefined()
  })

  it('accepts a bare profile object so a store row can be imported by hand', () => {
    const parsed = parseProfileBundleText(JSON.stringify(baseProfile({ name: 'Hand' })))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.kind).toBe(PROFILE_BUNDLE_KIND)
    expect(parsed.bundle.profile.name).toBe('Hand')
    expect(parsed.bundle.roleTemplates).toEqual([])
  })

  it('rejects junk JSON and a foreign envelope', () => {
    expect(parseProfileBundleText('not json')).toEqual({ ok: false, reason: 'json' })
    expect(parseProfileBundleText('{"kind":"other.thing","version":1}')).toEqual({
      ok: false,
      reason: 'schema'
    })
    expect(
      parseProfileBundleText(
        JSON.stringify({ kind: PROFILE_BUNDLE_KIND, version: 99, profile: baseProfile() })
      )
    ).toEqual({ ok: false, reason: 'schema' })
  })

  it('round-trips through pretty JSON', () => {
    const text = serializeProfileBundle(packProfileBundle(baseProfile({ name: 'Pretty' })))
    expect(text.endsWith('\n')).toBe(true)
    const parsed = parseProfileBundleText(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.profile.name).toBe('Pretty')
  })
})

describe('adoptRoleTemplates / importProfileFromBundle', () => {
  it('adds a missing custom role and remaps when the id is taken by a different one', () => {
    const existing: RoleTemplate = { id: 'qa', name: 'QA', prompt: 'Local QA.', builtin: false }
    const incoming: RoleTemplate = { id: 'qa', name: 'QA', prompt: 'Imported QA.', builtin: false }
    const { templates, remap } = adoptRoleTemplates([incoming], [existing], () => 'qa-2')
    expect(templates).toEqual([{ ...incoming, id: 'qa-2' }])
    expect(remap.get('qa')).toBe('qa-2')
  })

  it('reuses an identical existing role instead of duplicating it', () => {
    const { templates, remap } = adoptRoleTemplates([qa], [qa], () => 'should-not-run')
    expect(templates).toEqual([])
    expect(remap.size).toBe(0)
  })

  it('creates a new profile with a fresh id, keeps a unique name, and drops zones', () => {
    const source = baseProfile({
      name: 'UWE',
      rolePrompts: [{ roleId: 'qa', prompt: 'German, please.' }],
      slots: [{ id: 's1', roleId: 'qa', providerId: 'claude' }],
      zones: { zones: [{ roleId: 'qa', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }
    })
    const bundle = packProfileBundle(source, [qa])
    const { profile, roleTemplates } = importProfileFromBundle(bundle, [], [], {
      importedWord: 'importiert',
      id: 'imported-1'
    })
    expect(profile.id).toBe('imported-1')
    expect(profile.name).toBe('UWE')
    expect(profile.zones).toBeUndefined()
    expect(profile.slots[0]!.id).not.toBe('s1')
    expect(profile.slots[0]!.roleId).toBe('qa')
    expect(profile.rolePrompts).toEqual([{ roleId: 'qa', prompt: 'German, please.' }])
    expect(roleTemplates).toEqual([qa])
  })

  it('suffixes the name when it is taken and remaps a colliding custom role', () => {
    const source = baseProfile({
      slots: [{ id: 's1', roleId: 'qa', providerId: 'claude' }]
    })
    const bundle = packProfileBundle(source, [qa])
    const existingQa: RoleTemplate = { id: 'qa', name: 'QA', prompt: 'Different.', builtin: false }
    let roleSeq = 0
    const { profile, roleTemplates } = importProfileFromBundle(
      bundle,
      [baseProfile()],
      [existingQa],
      {
        importedWord: 'imported',
        createRoleId: () => `qa-new-${(roleSeq += 1)}`
      }
    )
    expect(profile.name).toBe('Vertragus (imported)')
    expect(profile.slots[0]!.roleId).toBe('qa-new-1')
    expect(roleTemplates[0]!.id).toBe('qa-new-1')
    expect(roleTemplates[0]!.prompt).toBe('Find bugs.')
  })

  it('ignores a shipped role id that snuck into the file', () => {
    const { templates } = adoptRoleTemplates(
      [{ id: 'worker', name: 'Worker', prompt: 'Nope.', builtin: true }],
      []
    )
    expect(templates).toEqual([])
  })
})

describe('suggestedProfileFilename / ensureJsonExtension', () => {
  it('slugs the name and falls back when nothing safe remains', () => {
    expect(suggestedProfileFilename('UWE Core')).toBe('vertragus-uwe-core.json')
    expect(suggestedProfileFilename('Größe / path')).toBe('vertragus-grosse-path.json')
    expect(suggestedProfileFilename('***')).toBe('vertragus-profile.json')
  })

  it('appends .json when the save dialog omitted it', () => {
    expect(ensureJsonExtension('C:/tmp/uwe.json')).toBe('C:/tmp/uwe.json')
    expect(ensureJsonExtension('C:/tmp/uwe')).toBe('C:/tmp/uwe.json')
    expect(ensureJsonExtension('C:/tmp/UWE.JSON')).toBe('C:/tmp/UWE.JSON')
  })
})
