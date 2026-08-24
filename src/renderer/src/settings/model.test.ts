import { describe, expect, it } from 'vitest'
import { extraMcpServerSchema } from '@shared/schema/mcpServer'
import { translator } from '../i18n'
import type { PanelMcpServer } from '../../../preload'
import {
  ACCELERATOR_MODIFIERS,
  emptyMcpDraft,
  parseArgLines,
  parseEnvLines,
  parseHeaderLines,
  toMcpServersPatch,
  validateAccelerator,
  validateMcpDraft
} from './model'

/** The authored language — the assertions read as the real UI reads. */
const t = translator('de')
const en = translator('en')

describe('validateAccelerator', () => {
  it('accepts the shipped default and the usual combinations', () => {
    for (const value of [
      'Control+Alt+V',
      'CommandOrControl+Shift+H',
      'Alt+Space',
      'Super+F12',
      'Ctrl+Shift+Escape',
      'Control+num5',
      'Control+Alt+Plus',
      'Control+/'
    ]) {
      expect(validateAccelerator(t, value), value).toEqual({ ok: true })
    }
  })

  it('accepts every modifier Electron documents', () => {
    for (const modifier of ACCELERATOR_MODIFIERS) {
      expect(validateAccelerator(t, `${modifier}+K`), modifier).toEqual({ ok: true })
    }
  })

  it('is case-insensitive about modifiers and keys', () => {
    expect(validateAccelerator(t, 'cOnTrOl+aLt+v')).toEqual({ ok: true })
  })

  it('refuses an empty field with a reason', () => {
    expect(validateAccelerator(t, '')).toMatchObject({ ok: false })
    expect(validateAccelerator(t, '   ')).toMatchObject({ ok: false })
  })

  /**
   * The reason this is stricter than Electron: `globalShortcut.register('K')`
   * is legal and swallows K in every app on the machine.
   */
  it('refuses a bare key — a global hotkey needs a modifier', () => {
    const result = validateAccelerator(t, 'K')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Modifier')
  })

  it('refuses a trailing plus that leaves no key', () => {
    const result = validateAccelerator(t, 'Control+')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('fehlt')
  })

  it('names the modifier it does not know', () => {
    const result = validateAccelerator(t, 'Strg+V')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Strg')
  })

  it('names the key it does not know', () => {
    const result = validateAccelerator(t, 'Control+Ätsch')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('Ätsch')
  })

  it('refuses the same modifier twice', () => {
    const result = validateAccelerator(t, 'Control+Control+V')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('doppelt')
  })

  it('answers in the language it is handed', () => {
    const result = validateAccelerator(en, 'Control+Control+V')
    expect(result.ok === false && result.reason).toBe('“Control” appears twice in the hotkey.')
    const empty = validateAccelerator(en, '   ')
    expect(empty.ok === false && empty.reason).toBe('Please enter a hotkey.')
  })

  it('refuses an F-key Electron does not have', () => {
    expect(validateAccelerator(t, 'Control+F24')).toEqual({ ok: true })
    expect(validateAccelerator(t, 'Control+F25').ok).toBe(false)
    expect(validateAccelerator(t, 'Control+F0').ok).toBe(false)
  })
})

describe('MCP draft helpers', () => {
  it('parses args, env and headers the way the form writes them', () => {
    expect(parseArgLines('  -y\n\n  github  \n')).toEqual(['-y', 'github'])
    expect(parseEnvLines('TOKEN=abc=def\n=dropped\nNAKED\n')).toEqual({
      TOKEN: 'abc=def',
      NAKED: ''
    })
    expect(parseHeaderLines('Authorization: Bearer a:b\n: skip\nX-Name:  v  \n')).toEqual({
      Authorization: 'Bearer a:b',
      'X-Name': 'v'
    })
  })

  it('rejects empty label/id, reserved vertragus, duplicate, empty command and bad url', () => {
    const existing = [
      extraMcpServerSchema.parse({
        id: 'github',
        label: 'GitHub',
        transport: 'stdio',
        command: 'npx'
      })
    ]
    const blank = emptyMcpDraft()
    const blankResult = validateMcpDraft(t, blank, [])
    expect(blankResult.ok).toBe(false)
    if (!blankResult.ok) {
      expect(blankResult.errors.label).toBeTruthy()
      expect(blankResult.errors.id).toBeTruthy()
      expect(blankResult.errors.command).toBeTruthy()
    }

    const dotted = validateMcpDraft(
      t,
      { ...emptyMcpDraft(), id: 'github.api', label: 'GitHub', command: 'npx' },
      []
    )
    expect(dotted.ok).toBe(false)
    if (!dotted.ok) expect(dotted.errors.id).toBeTruthy()

    const reserved = validateMcpDraft(
      t,
      { ...emptyMcpDraft(), id: 'vertragus', label: 'X', command: 'npx' },
      []
    )
    expect(reserved.ok).toBe(false)
    if (!reserved.ok) expect(reserved.errors.id).toContain('vertragus')

    const duplicate = validateMcpDraft(
      t,
      { ...emptyMcpDraft(), id: 'github', label: 'Other', command: 'npx' },
      existing
    )
    expect(duplicate.ok).toBe(false)

    const badUrl = validateMcpDraft(
      en,
      { ...emptyMcpDraft(), id: 'linear', label: 'Linear', transport: 'http', url: 'nope' },
      []
    )
    expect(badUrl.ok).toBe(false)
    if (!badUrl.ok) expect(badUrl.errors.url).toMatch(/URL/)
  })

  it('accepts a valid stdio draft', () => {
    const result = validateMcpDraft(
      t,
      {
        ...emptyMcpDraft(),
        id: 'GitHub',
        label: 'GitHub',
        command: 'npx',
        argsText: '-y\n@modelcontextprotocol/server-github',
        envText: 'TOKEN=secret'
      },
      []
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.server).toMatchObject({
        id: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { TOKEN: 'secret' }
      })
    }
  })
})

describe('mcp servers patch', () => {
  const github: PanelMcpServer = {
    id: 'github',
    label: 'GitHub',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    envKeys: ['GITHUB_TOKEN'],
    headerKeys: [],
    envSet: { GITHUB_TOKEN: true },
    headersSet: {}
  }

  it('sends empty strings for already-set env keys so main keeps the secret', () => {
    expect(toMcpServersPatch([github])).toEqual([
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        env: { GITHUB_TOKEN: '' }
      }
    ])
  })

  it('replaces a drafted env value and drops empty keys', () => {
    const patch = toMcpServersPatch([github], {
      github: { env: { GITHUB_TOKEN: 'new-secret', '': 'ignore' } }
    })
    expect(patch).toEqual([
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        env: { GITHUB_TOKEN: 'new-secret' }
      }
    ])
  })
})
