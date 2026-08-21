import { describe, expect, it } from 'vitest'
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON } from '@main/agents/interactiveReady'
import { PRESET_VERIFICATION, providerPresets } from '@main/providers/presets'
import {
  firstLine,
  formatMatrixTable,
  KEYBOARD_TAKEN,
  MATRIX_PROVIDERS,
  sawKeyboardTaken
} from './provider-matrix.mjs'

/** The script is plain JS; the casts pin the contract this test relies on. */
const format = formatMatrixTable as (rows: unknown[]) => string
const saw = sawKeyboardTaken as (buffer: string) => boolean
const first = firstLine as (text: string) => string

interface MatrixProvider {
  id: string
  label: string
  command: string
  versionArgs: string[]
  spawnArgs: string[] | null
  verifiedVersion: string
}
const matrix = MATRIX_PROVIDERS as MatrixProvider[]

/**
 * The drift guard the .mjs comment promises: its tuples are duplicated from
 * presets.ts / presetVerification.ts because a plain script cannot import
 * TypeScript — so THIS test, which can, holds the two sides equal. Editing a
 * preset without touching the script (or vice versa) fails here, not on a
 * Sunday-night workflow run.
 */
describe('the probe table mirrors the shipped presets', () => {
  const presets = providerPresets()

  it('covers every preset exactly once, in preset order', () => {
    expect(matrix.map((row) => row.id)).toEqual(presets.map((preset) => preset.id))
  })

  it.each(matrix)('$id: command, version args and label match presets.ts', (row) => {
    const preset = presets.find((candidate) => candidate.id === row.id)!
    expect(row.command).toBe(preset.command)
    expect(row.versionArgs).toEqual(preset.versionArgs)
    expect(row.label).toBe(preset.label)
  })

  it.each(matrix)('$id: verified version matches PRESET_VERIFICATION', (row) => {
    expect(row.verifiedVersion).toBe(
      PRESET_VERIFICATION[row.id as keyof typeof PRESET_VERIFICATION].cliVersion
    )
  })

  it('skips the keyboard dry-run exactly for the presets that never announce', () => {
    for (const row of matrix) {
      const preset = presets.find((candidate) => candidate.id === row.id)!
      // A preset that opts out of the keyboard wait (`seed.keyboardWaitMs: 0`)
      // is a plain REPL — a DECSET 2004 dry-run against it can only time out.
      if (preset.seed?.keyboardWaitMs === 0) {
        expect(row.spawnArgs, row.id).toBeNull()
      } else {
        // Everyone else is spawned with the preset's own base args.
        expect(row.spawnArgs, row.id).toEqual(preset.args)
      }
    }
  })
})

describe('sawKeyboardTaken', () => {
  it('is the same byte sequence the seed handshake waits for', () => {
    expect(KEYBOARD_TAKEN).toBe(BRACKETED_PASTE_ON)
  })

  it('detects the announcement inside real-looking boot output', () => {
    expect(saw(`Welcome to codex\r\n${BRACKETED_PASTE_ON}\x1b[2J`)).toBe(true)
    // Weaker than bracketedPasteActive on purpose: a CLI that took the
    // keyboard and handed it back (shelling out) still proved the launch.
    expect(saw(`${BRACKETED_PASTE_ON}painting…${BRACKETED_PASTE_OFF}`)).toBe(true)
  })

  it('is not fooled by output without the enable sequence', () => {
    expect(saw('')).toBe(false)
    expect(saw('plain REPL prompt >>> ')).toBe(false)
    // The literal text of the sequence, without the escape byte, is just prose.
    expect(saw('the CLI prints [?2004h when it boots')).toBe(false)
    expect(saw(BRACKETED_PASTE_OFF)).toBe(false)
  })
})

describe('formatMatrixTable', () => {
  const rows = [
    {
      label: 'Claude Code',
      installed: '2.0.5 (Claude Code)',
      verified: '2.0.5',
      spawnOk: 'yes',
      keyboardOk: 'yes'
    },
    {
      label: 'Ollama (local)',
      installed: 'ollama version is 0.30.11',
      verified: '0.30.11',
      spawnOk: 'n/a (line REPL, needs a local model)',
      keyboardOk: 'n/a (never announces DECSET 2004)'
    }
  ]

  it('renders the five documented columns as a markdown table', () => {
    expect(format(rows)).toBe(
      [
        '| Provider | Installed version | Verified against | Spawn ok | Keyboard ok |',
        '| --- | --- | --- | --- | --- |',
        '| Claude Code | 2.0.5 (Claude Code) | 2.0.5 | yes | yes |',
        '| Ollama (local) | ollama version is 0.30.11 | 0.30.11 | n/a (line REPL, needs a local model) | n/a (never announces DECSET 2004) |'
      ].join('\n')
    )
  })

  it('keeps a hostile cell from breaking the table', () => {
    const table = format([
      {
        label: 'X',
        installed: 'v1 | rm -rf\nsecond line',
        verified: 'v1',
        spawnOk: 'no',
        keyboardOk: 'no'
      }
    ])
    expect(table).toContain('| X | v1 \\| rm -rf second line | v1 | no | no |')
  })
})

describe('firstLine', () => {
  it('reads a version answer the way providers/health.ts does', () => {
    expect(first('\n\ncodex-cli 0.144.6\nextra')).toBe('codex-cli 0.144.6')
    expect(first('  2026.08.11-e8db854 \r\n')).toBe('2026.08.11-e8db854')
    expect(first('')).toBe('')
  })
})
