import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type WorkspaceProfile } from '@shared/profile'

const store = vi.hoisted(() => ({
  profile: undefined as WorkspaceProfile | undefined,
  saved: [] as WorkspaceProfile[]
}))

vi.mock('@main/config/store', () => ({
  getProfile: (id: string) => (store.profile?.id === id ? store.profile : undefined),
  saveProfile: (profile: WorkspaceProfile) => {
    store.profile = profile
    store.saved.push(profile)
    return [profile]
  }
}))

import {
  listProfileSkills,
  recordProfileSkill,
  removeProfileSkill,
  skillsPromptBlock
} from './profileSkills'

beforeEach(() => {
  store.profile = { ...DEFAULT_PROFILE, id: 'p1', skills: [] }
  store.saved = []
})

describe('profile skills', () => {
  it('creates, upserts (case-insensitive) and lists skills', () => {
    const created = recordProfileSkill('p1', {
      name: 'Deploy-Ablauf',
      instructions: 'Erst Gates, dann Tag, dann Release-Workflow.'
    })
    expect(created.ok).toBe(true)
    expect(created.skill?.source).toBe('orchestrator')

    const updated = recordProfileSkill('p1', {
      name: 'deploy-ablauf',
      instructions: 'Neu: zusätzlich Changelog prüfen.'
    })
    expect(updated.ok).toBe(true)
    expect(updated.skills).toHaveLength(1)
    expect(updated.skill?.id).toBe(created.skill?.id)
    expect(updated.skill?.instructions).toContain('Changelog')
    expect(listProfileSkills('p1')).toHaveLength(1)
  })

  it('keeps user ownership when the orchestrator refines a user skill', () => {
    recordProfileSkill('p1', { name: 'Review', instructions: 'A', source: 'user' })
    const refined = recordProfileSkill('p1', { name: 'review', instructions: 'B' })
    expect(refined.skill?.source).toBe('user')
  })

  it('enforces the skill cap and input bounds', () => {
    for (let i = 0; i < 24; i += 1) {
      expect(recordProfileSkill('p1', { name: `skill-${i}`, instructions: 'x' }).ok).toBe(true)
    }
    const beyond = recordProfileSkill('p1', { name: 'zu-viel', instructions: 'x' })
    expect(beyond.ok).toBe(false)
    expect(beyond.message).toContain('Skill-Limit')
    expect(recordProfileSkill('p1', { name: '', instructions: 'x' }).ok).toBe(false)
  })

  it('removes by exact name and reports unknown names', () => {
    recordProfileSkill('p1', { name: 'Weg damit', instructions: 'x' })
    expect(removeProfileSkill('p1', 'weg damit').ok).toBe(true)
    expect(listProfileSkills('p1')).toHaveLength(0)
    expect(removeProfileSkill('p1', 'gibts nicht').ok).toBe(false)
  })

  it('fails gracefully without an active profile', () => {
    expect(recordProfileSkill(undefined, { name: 'x', instructions: 'y' }).ok).toBe(false)
    expect(listProfileSkills(undefined)).toEqual([])
  })
})

describe('skillsPromptBlock', () => {
  it('renders a bounded block and truncates with a hint', () => {
    expect(skillsPromptBlock([])).toBe('')
    const skills = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      name: `Skill ${i}`,
      instructions: 'Anleitung '.repeat(50),
      source: 'user' as const,
      createdAt: 1,
      updatedAt: 1
    }))
    const block = skillsPromptBlock(skills, 800)
    expect(block).toContain('Profil-Skills')
    expect(block).toContain('Skill 0')
    expect(block).toContain('weitere Skills gekürzt')
    expect(block.length).toBeLessThan(1_100)
  })
})
