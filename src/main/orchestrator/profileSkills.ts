/**
 * Per-profile skill management: named, reusable workspace procedures stored on
 * the WorkspaceProfile and injected into orchestrator/solo system prompts.
 * The orchestrator extends them itself via the MCP tools (record_skill /
 * remove_skill), so a profile accumulates workspace-specific know-how across
 * runs. Upserts are keyed case-insensitively by name; the list is bounded by
 * MAX_PROFILE_SKILLS from the schema.
 */
import { randomUUID } from 'node:crypto'
import {
  MAX_PROFILE_SKILLS,
  profileSkillSchema,
  type ProfileSkill,
  type WorkspaceProfile
} from '@shared/profile'
import { getProfile, saveProfile } from '@main/config/store'

export interface RecordSkillInput {
  name: string
  instructions: string
  source?: ProfileSkill['source']
}

export interface RecordSkillResult {
  ok: boolean
  message: string
  skill?: ProfileSkill
  skills?: ProfileSkill[]
}

export function listProfileSkills(profileId: string | undefined): ProfileSkill[] {
  if (!profileId) return []
  return getProfile(profileId)?.skills ?? []
}

/** Upsert one skill (case-insensitive name key) and persist the profile. */
export function recordProfileSkill(
  profileId: string | undefined,
  input: RecordSkillInput
): RecordSkillResult {
  const profile = profileId ? getProfile(profileId) : undefined
  if (!profile) {
    return { ok: false, message: 'Kein aktives Workspace-Profil — Skill wurde nicht gespeichert.' }
  }
  const parsed = profileSkillSchema.safeParse({
    id: randomUUID(),
    name: input.name.trim(),
    instructions: input.instructions.trim(),
    source: input.source ?? 'orchestrator',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  if (!parsed.success) {
    return { ok: false, message: `Ungültiger Skill: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
  }
  const skills = [...(profile.skills ?? [])]
  const key = parsed.data.name.toLowerCase()
  const existingIndex = skills.findIndex((skill) => skill.name.toLowerCase() === key)
  if (existingIndex >= 0) {
    const existing = skills[existingIndex]
    skills[existingIndex] = {
      ...parsed.data,
      id: existing.id,
      createdAt: existing.createdAt,
      // A user-authored skill stays user-owned even when the orchestrator refines it.
      source: existing.source === 'user' ? 'user' : parsed.data.source
    }
  } else {
    if (skills.length >= MAX_PROFILE_SKILLS) {
      return {
        ok: false,
        message: `Skill-Limit erreicht (${MAX_PROFILE_SKILLS}). Entferne oder konsolidiere zuerst einen bestehenden Skill.`
      }
    }
    skills.push(parsed.data)
  }
  persistSkills(profile, skills)
  const stored = existingIndex >= 0 ? skills[existingIndex] : skills[skills.length - 1]
  return {
    ok: true,
    message: existingIndex >= 0 ? `Skill "${stored.name}" aktualisiert.` : `Skill "${stored.name}" angelegt.`,
    skill: stored,
    skills
  }
}

/** Remove a skill by exact (case-insensitive) name and persist the profile. */
export function removeProfileSkill(
  profileId: string | undefined,
  name: string
): RecordSkillResult {
  const profile = profileId ? getProfile(profileId) : undefined
  if (!profile) {
    return { ok: false, message: 'Kein aktives Workspace-Profil.' }
  }
  const key = name.trim().toLowerCase()
  const skills = profile.skills ?? []
  const remaining = skills.filter((skill) => skill.name.toLowerCase() !== key)
  if (remaining.length === skills.length) {
    return { ok: false, message: `Kein Skill namens "${name.trim()}" in diesem Profil.` }
  }
  persistSkills(profile, remaining)
  return { ok: true, message: `Skill "${name.trim()}" entfernt.`, skills: remaining }
}

function persistSkills(profile: WorkspaceProfile, skills: ProfileSkill[]): void {
  saveProfile({ ...profile, skills })
}

/** Bounded prompt block for orchestrator/solo system prompts ('' when empty). */
export function skillsPromptBlock(skills: ProfileSkill[] | undefined, maxChars = 8_000): string {
  if (!skills || skills.length === 0) return ''
  const lines: string[] = [
    'Profil-Skills (in diesem Workspace erlernte Verfahren; wende sie an, wenn ihre Situation eintritt):'
  ]
  let used = lines[0].length
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.instructions.replace(/\s+/g, ' ').trim()}`
    if (used + line.length > maxChars) {
      lines.push(`- … ${skills.length - (lines.length - 1)} weitere Skills gekürzt (list_skills zeigt alle).`)
      break
    }
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}
