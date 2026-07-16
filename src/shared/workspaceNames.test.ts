import { describe, expect, it } from 'vitest'
import {
  MIDDLE_EARTH_WORKSPACE_NAMES,
  MIDDLE_EARTH_WORKSPACES,
  middleEarthWorkspaceName,
  middleEarthWorkspaceBlurb,
  shuffleMiddleEarthWorkspaceNames
} from './workspaceNames'

describe('middleEarthWorkspaceName', () => {
  it('keeps the curated location list free of duplicate names', () => {
    expect(new Set(MIDDLE_EARTH_WORKSPACE_NAMES).size).toBe(
      MIDDLE_EARTH_WORKSPACE_NAMES.length
    )
  })

  it('creates a deterministic, unique permutation with an injected random source', () => {
    const names = shuffleMiddleEarthWorkspaceNames(() => 0)

    expect(names).toHaveLength(MIDDLE_EARTH_WORKSPACE_NAMES.length)
    expect(new Set(names).size).toBe(names.length)
    expect(names[0]).not.toBe('Minas Tirith')
    expect(MIDDLE_EARTH_WORKSPACE_NAMES[0]).toBe('Minas Tirith')
  })

  it('uses the fixed names for the first three workspace sessions', () => {
    expect(middleEarthWorkspaceName(1)).toBe('Minas Tirith')
    expect(middleEarthWorkspaceName(2)).toBe('Düsterwald')
    expect(middleEarthWorkspaceName(3)).toBe('Hobbingen')
  })

  it('is deterministic for every sequence', () => {
    const sequences = [1, 7, MIDDLE_EARTH_WORKSPACE_NAMES.length + 2, 1_000_000_000]
    for (const sequence of sequences) {
      expect(middleEarthWorkspaceName(sequence)).toBe(middleEarthWorkspaceName(sequence))
    }
  })

  it('cycles through the list with a Roman suffix', () => {
    const nextCycle = MIDDLE_EARTH_WORKSPACE_NAMES.length
    expect(middleEarthWorkspaceName(nextCycle + 1)).toBe('Minas Tirith II')
    expect(middleEarthWorkspaceName(nextCycle * 2 + 3)).toBe('Hobbingen III')
  })

  it('applies cycle suffixes to a shuffled name order', () => {
    const names = shuffleMiddleEarthWorkspaceNames(() => 0)
    const nextCycle = names.length

    expect(middleEarthWorkspaceName(nextCycle + 1, names)).toBe(`${names[0]} II`)
  })

  it('falls back defensively for zero and negative sequences', () => {
    expect(middleEarthWorkspaceName(0)).toBe('Workspace 0')
    expect(middleEarthWorkspaceName(-12)).toBe('Workspace -12')
  })

  it('does not throw or produce uncontrolled output for absurd input', () => {
    expect(() => middleEarthWorkspaceName(Number.NaN)).not.toThrow()
    expect(middleEarthWorkspaceName(Number.NaN)).toBe('Workspace NaN')

    const hugeName = middleEarthWorkspaceName(1_000_000_000)
    expect(hugeName.length).toBeLessThan(100)
    expect(hugeName).toBe(middleEarthWorkspaceName(1_000_000_000))
  })
})

describe('middleEarthWorkspaceBlurb', () => {
  it('gives every curated place a non-empty description', () => {
    for (const place of MIDDLE_EARTH_WORKSPACES) {
      expect(place.blurb.trim().length).toBeGreaterThan(0)
    }
  })

  it('resolves the blurb for a bare place-name', () => {
    expect(middleEarthWorkspaceBlurb('Minas Tirith')).toBe(
      MIDDLE_EARTH_WORKSPACES[0]!.blurb
    )
  })

  it('resolves the blurb through a Roman cycle suffix', () => {
    const names = shuffleMiddleEarthWorkspaceNames(() => 0)
    const cycledName = middleEarthWorkspaceName(names.length + 1, names)

    expect(middleEarthWorkspaceBlurb(cycledName)).toBe(middleEarthWorkspaceBlurb(names[0]!))
  })

  it('returns undefined for custom or unknown names', () => {
    expect(middleEarthWorkspaceBlurb('Mein eigener Workspace')).toBeUndefined()
    expect(middleEarthWorkspaceBlurb('')).toBeUndefined()
  })
})
