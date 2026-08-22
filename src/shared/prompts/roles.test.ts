import { describe, expect, it } from 'vitest'
import { roleTemplateSchema } from '../schema/profile'
import {
  allRoleTemplates,
  BUILTIN_ROLE_TEMPLATES,
  builtinRoleTemplate,
  ORCHESTRATOR_COLOR,
  ROLE_COLOR_POOL,
  roleColor
} from './roles'

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

describe('BUILTIN_ROLE_TEMPLATES', () => {
  it('ships exactly the seven documented roles with unique ids', () => {
    expect(BUILTIN_ROLE_TEMPLATES.map((template) => template.id)).toEqual([
      'worker',
      'reviewer',
      'tester',
      'architect',
      'docs',
      'janitor',
      'explorer'
    ])
  })

  it('validates against the role template schema and is marked builtin', () => {
    for (const template of BUILTIN_ROLE_TEMPLATES) {
      expect(roleTemplateSchema.safeParse(template).success).toBe(true)
      expect(template.builtin).toBe(true)
    }
  })

  it('keeps every prompt in the 100–200 word band', () => {
    for (const template of BUILTIN_ROLE_TEMPLATES) {
      const words = wordCount(template.prompt)
      expect(words, `${template.id}: ${words} words`).toBeGreaterThanOrEqual(100)
      expect(words, `${template.id}: ${words} words`).toBeLessThanOrEqual(200)
    }
  })

  it('points every role at the escalation tools without restating the contract', () => {
    for (const template of BUILTIN_ROLE_TEMPLATES) {
      expect(template.prompt).toMatch(/orchestrator/i)
      // The reporting contract is appended per launch; duplicating its rules
      // here is how two sources of truth start contradicting each other.
      expect(template.prompt).not.toMatch(/await_events|report_progress|ticket/i)
    }
  })

  it('forbids the read-only roles from editing anything', () => {
    for (const id of ['reviewer', 'architect', 'explorer']) {
      expect(builtinRoleTemplate(id)!.prompt).toMatch(/CHANGE NOTHING/)
    }
  })

  it('is written in English (agent-facing prompts, not UI copy)', () => {
    for (const template of BUILTIN_ROLE_TEMPLATES) {
      expect(template.prompt).not.toMatch(/[äöüß]/i)
    }
  })
})

describe('roleColor', () => {
  it('paints the orchestrator bronze and never pools that colour', () => {
    expect(roleColor('orchestrator')).toBe(ORCHESTRATOR_COLOR)
    expect(ROLE_COLOR_POOL).not.toContain(ORCHESTRATOR_COLOR)
  })

  it('gives every built-in role a stable, distinct colour', () => {
    const colors = BUILTIN_ROLE_TEMPLATES.map((template) => roleColor(template.id))
    expect(new Set(colors).size).toBe(colors.length)
    expect(roleColor('worker')).toBe('#2f7d6d')
    expect(roleColor('reviewer')).toBe('#8fa8c8')
    // The index argument must not move a built-in colour.
    expect(roleColor('worker', 7)).toBe('#2f7d6d')
  })

  it('assigns custom roles from the pool without colliding with Worker', () => {
    // Seven built-ins reserve pool[0..6]; custom roles start at pool[7].
    expect(roleColor('security-auditor', 0)).toBe(ROLE_COLOR_POOL[7])
    expect(roleColor('custom', -3)).toBe(ROLE_COLOR_POOL[7])
    // Wrapping is fine; a collision with the built-in block only happens after
    // the pool is exhausted.
    expect(roleColor('security-auditor', 1)).toBe(ROLE_COLOR_POOL[0])
    expect(roleColor('custom', 3)).toBe(ROLE_COLOR_POOL[2])
  })

  it('offers eight muted hex tones (no neon on glass)', () => {
    expect(ROLE_COLOR_POOL).toHaveLength(8)
    for (const color of [...ROLE_COLOR_POOL, ORCHESTRATOR_COLOR]) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
      const [r, g, b] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
      const max = Math.max(r!, g!, b!)
      const min = Math.min(r!, g!, b!)
      // Saturation below 0.7 and a mid-range value: nothing screams.
      expect((max - min) / max).toBeLessThan(0.7)
      expect(max).toBeLessThan(0.92 * 255)
    }
  })
})

describe('allRoleTemplates', () => {
  it('returns the built-ins when the user has no custom roles', () => {
    expect(allRoleTemplates()).toEqual([...BUILTIN_ROLE_TEMPLATES])
  })

  it('lets a custom template with a built-in id override the shipped prompt', () => {
    const custom = roleTemplateSchema.parse({ id: 'worker', name: 'Worker', prompt: 'Mine.' })
    const merged = allRoleTemplates([custom])
    expect(merged).toHaveLength(BUILTIN_ROLE_TEMPLATES.length)
    expect(merged[0]).toBe(custom)
  })

  it('appends genuinely new roles after the built-ins', () => {
    const custom = roleTemplateSchema.parse({ id: 'sre', name: 'SRE', prompt: 'Keep it up.' })
    const merged = allRoleTemplates([custom])
    expect(merged.at(-1)).toBe(custom)
    expect(merged).toHaveLength(BUILTIN_ROLE_TEMPLATES.length + 1)
  })
})
