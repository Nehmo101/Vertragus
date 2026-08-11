import { describe, expect, it } from 'vitest'
import { providerConfigSchema, type ProviderConfig } from '@shared/schema/provider'
import { translator } from '../i18n'
import {
  draftFromProvider,
  emptyDraft,
  fieldForPath,
  fromLines,
  messageForField,
  toLines,
  toProviderInput,
  validateDraft,
  type ProviderDraft
} from './model'

/** The authored language — the assertions read as the real UI reads. */
const t = translator('de')
const en = translator('en')

/**
 * Descriptors covering EVERY branch of the schema's four discriminated unions.
 *
 * Declared here rather than imported from `@main/providers/presets`: the
 * renderer must not reach into main. It is also the stronger check — the
 * shipped presets use five of these shapes, this covers all of them, including
 * combinations only a hand-written provider will ever have.
 */
const SHAPES: ProviderConfig[] = (
  [
    // Claude-like: flag effort, arg prompt, claude-json attach with both optionals.
    {
      id: 'shape-claude',
      presetId: 'claude',
      label: 'Claude-like',
      command: 'claude',
      yoloArgs: ['--dangerously-skip-permissions'],
      modelArg: '--model',
      effortArg: { style: 'flag', flag: '--effort' },
      auth: { loginArgs: ['auth', 'login'], statusArgs: ['auth', 'status'] },
      systemPromptDelivery: { kind: 'arg', flag: '--append-system-prompt' },
      mcp: {
        kind: 'claude-json',
        configArg: '--mcp-config',
        strictArg: '--strict-mcp-config',
        allowedToolsArg: '--allowedTools'
      },
      modelDiscovery: {
        kind: 'file',
        path: '~/.claude.json',
        parse: 'json',
        jsonPath: 'additionalModelOptionsCache[].value'
      },
      seedModels: ['opus', 'sonnet', 'haiku']
    },
    // Codex-like: template effort, codex-config prompt, codex-overrides attach.
    {
      id: 'shape-codex',
      presetId: 'codex',
      label: 'Codex-like',
      command: 'codex',
      yoloArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      modelArg: '--model',
      effortArg: { style: 'template', flag: '-c', template: 'model_reasoning_effort="{effort}"' },
      auth: { loginArgs: ['login'], statusArgs: ['login', 'status'] },
      systemPromptDelivery: { kind: 'codex-config' },
      mcp: { kind: 'codex-overrides' },
      modelDiscovery: {
        kind: 'file',
        path: '~/.codex/models_cache.json',
        parse: 'json',
        jsonPath: 'models[].slug'
      }
    },
    // Kimi-like: no effort knob, agent-file prompt, kimi-project attach, cli discovery.
    {
      id: 'shape-kimi',
      presetId: 'kimi',
      label: 'Kimi-like',
      command: 'kimi',
      yoloArgs: ['--yolo'],
      modelArg: '--model',
      auth: { loginArgs: ['login'] },
      systemPromptDelivery: { kind: 'agent-file', flag: '--agent-file' },
      mcp: { kind: 'kimi-project' },
      modelDiscovery: {
        kind: 'cli',
        args: ['provider', 'list', '--json'],
        parse: 'json',
        jsonPath: 'models'
      }
    },
    // Cursor-like: pty prompt, no attach, line-parsed cli discovery, disabled.
    {
      id: 'shape-cursor',
      label: 'Cursor-like',
      command: 'cursor-agent',
      yoloArgs: ['--yolo'],
      modelArg: '--model',
      auth: { loginArgs: ['login'], statusArgs: ['status'] },
      systemPromptDelivery: { kind: 'pty' },
      mcp: { kind: 'none' },
      modelDiscovery: { kind: 'cli', args: ['models'], parse: 'lines' },
      enabled: false
    },
    // Ollama-like: positional model (no modelArg), base args, http discovery.
    {
      id: 'shape-ollama',
      label: 'Ollama-like',
      command: 'ollama',
      args: ['run'],
      auth: { loginArgs: ['signin'] },
      systemPromptDelivery: { kind: 'pty' },
      mcp: { kind: 'none' },
      modelDiscovery: { kind: 'http', url: 'http://127.0.0.1:11434/api/tags', jsonPath: 'models[].name' }
    },
    // The branches no preset uses: a TOML-key file source, and claude-json
    // without either optional flag.
    {
      id: 'shape-toml',
      label: 'Toml-like',
      command: 'weird',
      versionArgs: ['-v'],
      systemPromptDelivery: { kind: 'arg', flag: '--sys' },
      mcp: { kind: 'claude-json', configArg: '--mcp' },
      modelDiscovery: { kind: 'file', path: '~/.weird/config.toml', parse: 'toml-keys' }
    }
  ] as const
).map((entry) => providerConfigSchema.parse(entry))

function shape(id: string): ProviderConfig {
  const config = SHAPES.find((candidate) => candidate.id === id)
  if (!config) throw new Error(`missing shape ${id}`)
  return config
}

function draft(overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    ...emptyDraft(),
    id: 'my-cli',
    label: 'Mein CLI',
    command: 'mycli',
    ...overrides
  }
}

describe('line lists', () => {
  it('drops blank lines instead of turning them into empty arguments', () => {
    expect(toLines('run\n\n  --json  \n')).toEqual(['run', '--json'])
    expect(toLines('')).toEqual([])
    expect(fromLines(['a', 'b'])).toBe('a\nb')
    expect(fromLines(undefined)).toBe('')
  })
})

describe('draft ⇄ ProviderConfig', () => {
  it('round-trips every descriptor shape the schema allows', () => {
    for (const config of SHAPES) {
      const result = validateDraft(t, draftFromProvider(config))
      expect(result.ok, `${config.id} must survive the form`).toBe(true)
      if (!result.ok) continue
      // Byte-identical back out: a form that quietly drops `strictArg` or
      // `seedModels` turns "open and save" into an edit nobody made.
      expect(result.config, config.id).toEqual(config)
    }
  })

  it('omits optionals instead of persisting an empty string', () => {
    const input = toProviderInput(draft()) as Record<string, unknown>
    // An empty modelArg means "the model is positional" (ollama run <model>) —
    // storing `''` would produce a launch with a nameless flag.
    expect(input).not.toHaveProperty('modelArg')
    expect(input).not.toHaveProperty('effortArg')
    expect(input).not.toHaveProperty('auth')
    expect(input).toMatchObject({ mcp: { kind: 'none' }, modelDiscovery: { kind: 'none' } })
  })

  it('writes an auth block as soon as there is a login command', () => {
    const input = toProviderInput(draft({ authLoginArgs: 'auth\nlogin' })) as {
      auth?: { loginArgs: string[]; statusArgs?: string[] }
    }
    expect(input.auth).toEqual({ loginArgs: ['auth', 'login'] })
  })

  it('keeps the optional claude-json flags optional', () => {
    const input = toProviderInput(
      draft({ mcpKind: 'claude-json', mcpConfigArg: '--mcp-config' })
    ) as { mcp: Record<string, unknown> }
    // A CLI without a strict mode still attaches; it is only less contained.
    expect(input.mcp).toEqual({ kind: 'claude-json', configArg: '--mcp-config' })
  })

  it('drops the fields of the attach mode that is NOT selected', () => {
    // Typing a config flag and then switching to Codex must not smuggle the
    // Claude flag into the stored record.
    const input = toProviderInput(
      draft({ mcpKind: 'codex-overrides', mcpConfigArg: '--mcp-config' })
    ) as { mcp: unknown }
    expect(input.mcp).toEqual({ kind: 'codex-overrides' })
  })

  it('normalizes an id typed with spaces and capitals', () => {
    const result = validateDraft(t, draft({ id: 'Mein CLI!' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.id).toBe('mein-cli')
  })
})

describe('validation', () => {
  it('pins each rejection on its own field', () => {
    const result = validateDraft(t, 
      draft({
        label: '',
        command: '',
        effortStyle: 'template',
        effortFlag: '-c',
        effortTemplate: 'model_reasoning_effort="high"',
        mcpKind: 'claude-json',
        mcpConfigArg: '',
        discoveryKind: 'http',
        discoveryUrl: 'not-a-url',
        discoveryJsonPath: ''
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual([
      'command',
      'discoveryJsonPath',
      'discoveryUrl',
      'effortTemplate',
      'label',
      'mcpConfigArg'
    ])
    expect(result.errors.effortTemplate).toContain('{effort}')
  })

  it('refuses an id that normalizes to nothing', () => {
    const result = validateDraft(t, draft({ id: '///' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.id).toBeTruthy()
  })

  it('refuses an id that would silently replace another provider', () => {
    const result = validateDraft(t, draft({ id: 'claude' }), ['claude', 'codex'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.id).toContain('schon')
  })

  it('lets a preset keep its own id — that is what editing a built-in is', () => {
    // The editor passes every id EXCEPT this record's own as taken.
    expect(validateDraft(t, draftFromProvider(shape('shape-claude')), ['codex']).ok).toBe(true)
  })

  it('answers in the language it is handed', () => {
    const result = validateDraft(en, draft({ id: 'claude' }), ['claude'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.id).toBe('This id already exists.')
    expect(messageForField(en, 'discoveryUrl')).toBe(
      'Please enter a complete url (with http:// or https://).'
    )
    expect(messageForField(t, 'discoveryUrl')).toContain('vollständige Url')
  })

  it('maps nested schema paths onto form fields', () => {
    expect(fieldForPath('mcp.configArg')).toBe('mcpConfigArg')
    expect(fieldForPath('modelDiscovery.url')).toBe('discoveryUrl')
    expect(fieldForPath('effortArg.template')).toBe('effortTemplate')
    // One rejected entry belongs on the whole textarea, not on `form`.
    expect(fieldForPath('args.3')).toBe('args')
    expect(fieldForPath('auth.loginArgs.0')).toBe('authLoginArgs')
    expect(fieldForPath('something.unknown')).toBe('form')
  })

  it('accepts what the store accepts — no second, stricter opinion', () => {
    const result = validateDraft(t, draftFromProvider(shape('shape-kimi')))
    expect(result.ok).toBe(true)
    if (result.ok) expect(() => providerConfigSchema.parse(result.config)).not.toThrow()
  })
})
