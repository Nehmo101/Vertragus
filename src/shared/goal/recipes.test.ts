import { describe, expect, it } from 'vitest'
import { classifyRecipe, GOAL_COMPILE_MODES, RECIPE_IDS } from './recipes'

describe('classifyRecipe', () => {
  it('keeps the closed unions stable', () => {
    expect(GOAL_COMPILE_MODES).toEqual(['off', 'cheap', 'scout'])
    expect(RECIPE_IDS).toContain('presence-gauntlet')
    expect(RECIPE_IDS).toContain('ship-in-place')
  })

  it('picks presence for visual AAA wording in either language', () => {
    expect(classifyRecipe('terra visuell auf aaa. bleibt ghibli.')).toBe('presence-gauntlet')
    expect(classifyRecipe('Make the panel look AAA, no plastic UX')).toBe('presence-gauntlet')
  })

  it('picks fix-and-verify for CI / bug wording', () => {
    expect(classifyRecipe('ci rot nach dem letzten merge. nur der flake.')).toBe(
      'fix-and-verify'
    )
    expect(classifyRecipe('Fix the login bug')).toBe('fix-and-verify')
  })

  it('picks invariant-first before a generic fix when security words appear', () => {
    expect(classifyRecipe('portal notes must never leak dm_only titles')).toBe(
      'invariant-first'
    )
  })

  it('picks scout-then-brief when the user forbids building', () => {
    expect(classifyRecipe('plane wie sessions zum ingame-modul werden. noch nicht bauen.')).toBe(
      'scout-then-brief'
    )
    expect(classifyRecipe('Research how auth should work. Do not build.')).toBe(
      'scout-then-brief'
    )
  })

  it('picks docs-only for documentation work', () => {
    expect(classifyRecipe('Update the handbook twins and the changelog')).toBe('docs-only')
  })

  it('defaults unknown feature asks to ship-in-place', () => {
    expect(classifyRecipe('family calendar should sync caldav again')).toBe('ship-in-place')
    expect(classifyRecipe('')).toBe('ship-in-place')
  })
})
