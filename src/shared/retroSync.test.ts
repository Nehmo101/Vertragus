import { describe, expect, it } from 'vitest'
import {
  assertSafeRetroBranch,
  normalizeRetroSyncOwner,
  normalizeRetroSyncRepo
} from './retroSync'

describe('retroSync validation', () => {
  it('normalizes valid owners and rejects invalid ones', () => {
    expect(normalizeRetroSyncOwner('Nehmo101')).toBe('Nehmo101')
    expect(normalizeRetroSyncOwner('  @Nehmo101 ')).toBe('Nehmo101')
    expect(() => normalizeRetroSyncOwner('')).toThrow(/Ungültiger GitHub-Owner/)
    expect(() => normalizeRetroSyncOwner('-nope')).toThrow(/Ungültiger GitHub-Owner/)
    expect(() => normalizeRetroSyncOwner('a b')).toThrow(/Ungültiger GitHub-Owner/)
    expect(() => normalizeRetroSyncOwner(42)).toThrow(/Ungültiger GitHub-Owner/)
  })

  it('normalizes valid repo names and rejects invalid ones', () => {
    expect(normalizeRetroSyncRepo('Orca-Strator')).toBe('Orca-Strator')
    expect(normalizeRetroSyncRepo(' my.repo_1 ')).toBe('my.repo_1')
    expect(() => normalizeRetroSyncRepo('')).toThrow(/Ungültiger GitHub-Repo-Name/)
    expect(() => normalizeRetroSyncRepo('owner/repo')).toThrow(/Ungültiger GitHub-Repo-Name/)
  })

  it('accepts safe retro branches and returns the normalized name', () => {
    expect(assertSafeRetroBranch('retros')).toBe('retros')
    expect(assertSafeRetroBranch(' orca/retros ')).toBe('orca/retros')
  })

  it('refuses protected and invalid branches', () => {
    expect(() => assertSafeRetroBranch('main')).toThrow(/geschützten Branch/)
    expect(() => assertSafeRetroBranch('MASTER')).toThrow(/geschützten Branch/)
    expect(() => assertSafeRetroBranch('')).toThrow(/Ungültiger Retro-Branch-Name/)
    expect(() => assertSafeRetroBranch('bad branch')).toThrow(/Ungültiger Retro-Branch-Name/)
    expect(() => assertSafeRetroBranch(undefined)).toThrow(/Ungültiger Retro-Branch-Name/)
  })

  it('refuses the repository default branch case-insensitively', () => {
    expect(() => assertSafeRetroBranch('DEV', 'dev')).toThrow(/geschützten Branch/)
    expect(() => assertSafeRetroBranch('dev', ' DEV ')).toThrow(/geschützten Branch/)
    expect(assertSafeRetroBranch('retros', 'dev')).toBe('retros')
  })
})
