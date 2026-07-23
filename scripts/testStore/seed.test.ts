import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { workspaceProfileSchema } from '../../src/shared/profile'
import { ideaSchema } from '../../src/shared/inbox'
import { mcpServersSchema } from '../../src/shared/mcp'
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  migrateConfigSnapshot
} from '../../src/main/config/migrations'
import { seedTestStore } from './seed'

const dir = mkdtempSync(join(tmpdir(), 'vertragus-seed-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('test-store seed', () => {
  it('writes a config that re-parses through the production schemas and migration', () => {
    const { files } = seedTestStore(dir)
    expect(files).toHaveLength(2)

    const config = JSON.parse(readFileSync(join(dir, 'vertragus.json'), 'utf8'))
    expect(config.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
    expect(config.profiles.length).toBeGreaterThanOrEqual(4)
    for (const profile of config.profiles) {
      expect(workspaceProfileSchema.safeParse(profile).success).toBe(true)
    }
    expect(config.profiles.some((profile: { solo?: boolean }) => profile.solo)).toBe(true)
    expect(config.profiles.map((profile: { id: string }) => profile.id)).toContain(
      config.activeProfileId
    )
    // The migration treats the seeded snapshot as current (no rewrite needed).
    const migrated = migrateConfigSnapshot(config)
    expect(migrated.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
    expect(mcpServersSchema.safeParse(config.settings.mcpServers).success).toBe(true)
    expect(Array.isArray(config.settings.runRetros)).toBe(true)
    expect(Array.isArray(config.settings.modelLearnings)).toBe(true)
    expect(Array.isArray(config.settings.benchmarkRecords)).toBe(true)
  })

  it('writes inbox ideas that re-parse through the idea schema', () => {
    seedTestStore(dir)
    const inbox = JSON.parse(readFileSync(join(dir, 'vertragus-inbox.json'), 'utf8'))
    expect(inbox.ideas.length).toBeGreaterThanOrEqual(3)
    for (const idea of inbox.ideas) {
      expect(ideaSchema.safeParse(idea).success).toBe(true)
    }
    const statuses = new Set(inbox.ideas.map((idea: { status: string }) => idea.status))
    expect(statuses.size).toBeGreaterThanOrEqual(3)
  })
})
