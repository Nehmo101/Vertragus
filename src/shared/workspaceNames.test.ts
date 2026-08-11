import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PLACE_NAMES,
  WORKSPACE_PLACES,
  workspacePlaceName,
  workspacePlaceBlurb,
  shuffleWorkspacePlaceNames
} from './workspaceNames'

describe('workspacePlaceName', () => {
  it('keeps the curated location list free of duplicate names', () => {
    expect(new Set(WORKSPACE_PLACE_NAMES).size).toBe(WORKSPACE_PLACE_NAMES.length)
  })

  it('creates a deterministic, unique permutation with an injected random source', () => {
    const names = shuffleWorkspacePlaceNames(() => 0)

    expect(names).toHaveLength(WORKSPACE_PLACE_NAMES.length)
    expect(new Set(names).size).toBe(names.length)
    expect(names[0]).not.toBe('Paradiso')
    expect(WORKSPACE_PLACE_NAMES[0]).toBe('Paradiso')
  })

  it('uses the fixed names for the first three workspace sessions', () => {
    expect(workspacePlaceName(1)).toBe('Paradiso')
    expect(workspacePlaceName(2)).toBe('Purgatorio')
    expect(workspacePlaceName(3)).toBe('Inferno')
  })

  it('is deterministic for every sequence', () => {
    const sequences = [1, 7, WORKSPACE_PLACE_NAMES.length + 2, 1_000_000_000]
    for (const sequence of sequences) {
      expect(workspacePlaceName(sequence)).toBe(workspacePlaceName(sequence))
    }
  })

  it('cycles through the list with a Roman suffix', () => {
    const nextCycle = WORKSPACE_PLACE_NAMES.length
    expect(workspacePlaceName(nextCycle + 1)).toBe('Paradiso II')
    expect(workspacePlaceName(nextCycle * 2 + 3)).toBe('Inferno III')
  })

  it('applies cycle suffixes to a shuffled name order', () => {
    const names = shuffleWorkspacePlaceNames(() => 0)
    const nextCycle = names.length

    expect(workspacePlaceName(nextCycle + 1, names)).toBe(`${names[0]} II`)
  })

  it('falls back defensively for zero and negative sequences', () => {
    expect(workspacePlaceName(0)).toBe('Workspace 0')
    expect(workspacePlaceName(-12)).toBe('Workspace -12')
  })

  it('does not throw or produce uncontrolled output for absurd input', () => {
    expect(() => workspacePlaceName(Number.NaN)).not.toThrow()
    expect(workspacePlaceName(Number.NaN)).toBe('Workspace NaN')

    const hugeName = workspacePlaceName(1_000_000_000)
    expect(hugeName.length).toBeLessThan(100)
    expect(hugeName).toBe(workspacePlaceName(1_000_000_000))
  })
})

describe('workspacePlaceBlurb', () => {
  it('gives every curated place a non-empty description', () => {
    for (const place of WORKSPACE_PLACES) {
      expect(place.blurb.trim().length).toBeGreaterThan(0)
    }
  })

  it('resolves the blurb for a bare place-name', () => {
    expect(workspacePlaceBlurb('Paradiso')).toBe(WORKSPACE_PLACES[0]!.blurb)
  })

  it('resolves the blurb through a Roman cycle suffix', () => {
    const names = shuffleWorkspacePlaceNames(() => 0)
    const cycledName = workspacePlaceName(names.length + 1, names)

    expect(workspacePlaceBlurb(cycledName)).toBe(workspacePlaceBlurb(names[0]!))
  })

  it('returns undefined for custom or unknown names', () => {
    expect(workspacePlaceBlurb('Mein eigener Workspace')).toBeUndefined()
    expect(workspacePlaceBlurb('')).toBeUndefined()
  })
})
