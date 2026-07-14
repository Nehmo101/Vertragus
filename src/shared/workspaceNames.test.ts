import { describe, expect, it } from 'vitest'
import {
  MIDDLE_EARTH_WORKSPACE_NAMES,
  middleEarthWorkspaceName
} from './workspaceNames'

describe('middleEarthWorkspaceName', () => {
  it('keeps the curated location list free of duplicate names', () => {
    expect(new Set(MIDDLE_EARTH_WORKSPACE_NAMES).size).toBe(
      MIDDLE_EARTH_WORKSPACE_NAMES.length
    )
  })

  it('uses the fixed names for the first three workspace sessions', () => {
    expect(middleEarthWorkspaceName(1)).toBe('Minas Tirith')
    expect(middleEarthWorkspaceName(2)).toBe('Minas Morgul')
    expect(middleEarthWorkspaceName(3)).toBe('Amon Sûl')
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
    expect(middleEarthWorkspaceName(nextCycle * 2 + 3)).toBe('Amon Sûl III')
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
