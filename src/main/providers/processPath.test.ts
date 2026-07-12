import { describe, expect, it } from 'vitest'
import { mergePathValues } from '@main/providers/processPath'

describe('mergePathValues', () => {
  it('keeps inherited entries and adds newly installed Windows paths', () => {
    expect(
      mergePathValues(
        ';',
        'C:\\Orca\\bin;C:\\Windows\\System32',
        'C:\\Windows\\System32;C:\\Program Files (x86)\\cloudflared\\',
        'C:\\Users\\test\\bin'
      )
    ).toBe(
      'C:\\Orca\\bin;C:\\Windows\\System32;C:\\Program Files (x86)\\cloudflared\\;C:\\Users\\test\\bin'
    )
  })

  it('deduplicates case-insensitively and ignores empty entries', () => {
    expect(mergePathValues(';', 'C:\\Tools;;', 'c:\\tools\\; C:\\Other ')).toBe(
      'C:\\Tools;C:\\Other'
    )
  })
})
