import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelMemory, ProviderConfig } from '@shared/schema/provider'
import { providerPreset } from './presets'
import {
  applyModelMemory,
  authFailureHint,
  cliFailureMessage,
  collectByPath,
  discoverModels,
  execProviderCli,
  expandHome,
  extractModels,
  familyAliases,
  MEMORY_TTL_MS,
  mergeSeedModels,
  normalizeModelMemory,
  parseLineModels,
  parseTomlModelKeys,
  type DiscoveryDependencies,
  type ProviderCliRuntime
} from './discovery'

vi.mock('@main/agents/resolveCommand', () => ({
  resolveLaunch: vi.fn(async (command: string, args: string[]) =>
    command === 'cursor-agent'
      ? {
          file: 'powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'C:\\Users\\t\\AppData\\Local\\cursor-agent\\cursor-agent.ps1',
            ...args
          ]
        }
      : { file: command, args }
  )
}))

/**
 * `execProviderCli` wraps `promisify(execFile)`, so the stand-in must carry the
 * promisify-custom symbol the real `execFile` has — otherwise the awaited value
 * would be a bare string and the `{ stdout }` destructuring in the module under
 * test would silently yield undefined.
 */
const execFileMock = vi.hoisted(() => {
  const calls: { file: string; args: string[] }[] = []
  /** Per-test stand-in for one run; unset means "answer the default catalogue". */
  const state: { run?: () => Promise<{ stdout: string; stderr: string }> } = {}
  const impl = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args })
    if (state.run) return state.run()
    return { stdout: 'auto - Auto (default)\ncomposer-2.5 - Composer 2.5\n', stderr: '' }
  }
  const fn = Object.assign(impl, { calls, state })
  Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
    value: impl,
    configurable: true
  })
  return fn
})
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock
}))

const FIXTURES = join(__dirname, '__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const NOW = 1_800_000_000_000

function preset(id: string): ProviderConfig {
  const config = providerPreset(id)
  if (!config) throw new Error(`missing preset ${id}`)
  return config
}

/**
 * Fully mocked dependencies — a discovery test must never touch a real CLI,
 * the user's home directory or the network.
 */
function deps(overrides: Partial<DiscoveryDependencies> = {}): {
  deps: Partial<DiscoveryDependencies>
  written: ModelMemory[]
} {
  const written: ModelMemory[] = []
  return {
    written,
    deps: {
      exec: vi.fn(async () => {
        throw new Error('exec not stubbed')
      }),
      readFile: vi.fn(() => {
        throw new Error('ENOENT')
      }),
      homeDir: () => '/home/tester',
      fetchJson: vi.fn(async () => {
        throw new Error('offline')
      }),
      now: () => NOW,
      readMemory: () => ({}),
      writeMemory: (memory) => {
        written.push(memory)
      },
      ...overrides
    }
  }
}

describe('expandHome', () => {
  it('expands a leading tilde on both separators and leaves other paths alone', () => {
    expect(expandHome('~/.claude.json', '/home/t')).toBe('/home/t/.claude.json')
    expect(expandHome('~\\.codex\\x.json', 'C:\\Users\\t')).toBe('C:\\Users\\t\\.codex\\x.json')
    expect(expandHome('~', '/home/t')).toBe('/home/t')
    expect(expandHome('/etc/models.json', '/home/t')).toBe('/etc/models.json')
    expect(expandHome('~notahome/x', '/home/t')).toBe('~notahome/x')
  })
})

describe('collectByPath', () => {
  const doc = {
    models: [{ name: 'a' }, { name: 'b' }],
    table: { one: { id: 'x' }, two: { id: 'y' } },
    nested: { deep: 'value' }
  }

  it('walks plain segments', () => {
    expect(collectByPath(doc, 'nested.deep')).toEqual(['value'])
  })

  it('iterates arrays with []', () => {
    expect(collectByPath(doc, 'models[].name')).toEqual(['a', 'b'])
  })

  it('iterates object VALUES with [] so a list-turned-table still works', () => {
    expect(collectByPath(doc, 'table[].id')).toEqual(['x', 'y'])
  })

  it('returns the root for an empty path and nothing for a missing key', () => {
    expect(collectByPath(doc, undefined)).toEqual([doc])
    expect(collectByPath(doc, 'nope.deeper')).toEqual([])
  })
})

describe('extractModels', () => {
  it('reads ids from strings, entry objects and keyed tables', () => {
    expect(extractModels(['opus'])).toEqual(['opus'])
    expect(extractModels([{ slug: 'gpt-5.6-sol' }])).toEqual(['gpt-5.6-sol'])
    expect(extractModels([{ 'kimi-k3': {}, 'kimi-k2': {} }])).toEqual(['kimi-k3', 'kimi-k2'])
  })

  it('strips ANSI colouring and blank entries', () => {
    const esc = String.fromCharCode(27)
    expect(extractModels([`${esc}[1mopus${esc}[0m`, '   '])).toEqual(['opus'])
  })

  it('keeps a bracketed context suffix — it is part of the id, not ANSI residue', () => {
    expect(extractModels(['claude-fable-5[1m]'])).toEqual(['claude-fable-5[1m]'])
  })
})

describe('mergeSeedModels', () => {
  it('appends only what discovery did not already offer', () => {
    expect(mergeSeedModels(['claude-opus-5'], ['opus', 'sonnet'])).toEqual({
      models: ['claude-opus-5', 'opus', 'sonnet'],
      added: ['opus', 'sonnet']
    })
  })

  it('keeps the discovered spelling and drops the seed twin', () => {
    expect(mergeSeedModels(['claude-sonnet-4.6'], ['claude-sonnet-4-6'])).toEqual({
      models: ['claude-sonnet-4.6'],
      added: []
    })
  })

  it('never reorders the discovered ids', () => {
    expect(mergeSeedModels(['b', 'a'], ['a']).models).toEqual(['b', 'a'])
  })
})

describe('parseLineModels', () => {
  it('keeps identifiers and drops headers, bullets and prose', () => {
    expect(
      parseLineModels(
        ['Available models:', '  * composer-2.5 - fast agent model', '- auto', '', 'not a model id'].join(
          '\n'
        )
      )
    ).toEqual(['composer-2.5', 'auto'])
  })

  // Verbatim capture of `cursor-agent models` on a logged-in machine.
  it('reads the real cursor-agent output: ids only, header and tip dropped', () => {
    const models = parseLineModels(fixture('cursor-agent-models.txt'))
    expect(models.length).toBeGreaterThan(150)
    expect(models.slice(0, 4)).toEqual([
      'auto',
      'gpt-5.3-codex-low',
      'gpt-5.3-codex-low-fast',
      'gpt-5.3-codex'
    ])
    expect(models).toContain('claude-opus-5-thinking-high')
    expect(models).toContain('glm-5.2-max')
    // The label half of `<id> - <Label>` must never leak into the picker.
    expect(models.some((model) => model.includes(' '))).toBe(false)
    expect(models).not.toContain('Available')
    expect(models.some((model) => model.toLowerCase().startsWith('tip'))).toBe(false)
  })
})

describe('parseTomlModelKeys', () => {
  it('reads only the [models.*] section keys, quoted or bare', () => {
    expect(parseTomlModelKeys(fixture('kimi-config.toml'))).toEqual(['kimi-code/k3', 'kimi-k3-turbo'])
  })
})

describe('familyAliases', () => {
  it('derives the rolling alias of every single-word family', () => {
    expect(familyAliases(['claude-opus-5', 'claude-sonnet-4-6', 'claude-opus-4-8'])).toEqual([
      'opus',
      'sonnet'
    ])
  })

  it('ignores multi-word product names', () => {
    expect(familyAliases(['kimi-for-coding'])).toEqual([])
  })
})

describe('discoverModels — file sources', () => {
  it('reads the Claude account cache and adds the rolling family aliases', async () => {
    const { deps: overrides } = deps({
      readFile: (path) => {
        expect(path).toBe('/home/tester/.claude.json')
        return fixture('claude-account-cache.json')
      }
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.source).toBe('live')
    expect(result.refreshedAt).toBe(NOW)
    // Alias first, then its pinned release — that is the picker's family order.
    expect(result.models).toEqual([
      'opus',
      'claude-opus-5',
      'sonnet',
      'claude-sonnet-5',
      'haiku',
      'claude-haiku-4-5'
    ])
  })

  it('fills the rolling aliases in when the account cache is too narrow', async () => {
    // Real `~/.claude.json` of a machine whose modelAccessCache is []: discovery
    // is correct and still finds a single id. Without the seeds the picker would
    // offer exactly `fable` and `claude-fable-5[1m]`.
    const { deps: overrides } = deps({
      readFile: () => fixture('claude-account-cache-narrow.json')
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.models).toEqual(['fable', 'claude-fable-5[1m]', 'opus', 'sonnet', 'haiku'])
    // Discovered ids keep their place; the seeds only fill the gap behind them.
    expect(result.source).toBe('mixed')
  })

  it('serves the seeds alone when nothing at all was discovered', async () => {
    const { deps: overrides } = deps()
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.models).toEqual(['opus', 'sonnet', 'haiku'])
    expect(result.source).toBe('seed')
    expect(result.detail).toContain('~/.claude.json')
  })

  it('does not remember a seed as something the provider was seen to offer', async () => {
    const { deps: overrides, written } = deps()
    await discoverModels(preset('claude'), overrides)
    expect(written).toEqual([])
  })

  it('also reads the cache when the CLI wrote it as a keyed table', async () => {
    const { deps: overrides } = deps({
      readFile: () => fixture('claude-account-cache-record.json')
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.models).toContain('claude-opus-5')
    expect(result.models).toContain('opus')
  })

  it('reads the Codex account catalogue', async () => {
    const { deps: overrides } = deps({
      readFile: (path) => {
        expect(path).toBe('/home/tester/.codex/models_cache.json')
        return fixture('codex-models-cache.json')
      }
    })
    const result = await discoverModels(preset('codex'), overrides)
    expect(result.source).toBe('live')
    expect(result.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'])
  })

  it('does not derive aliases for non-Claude providers', async () => {
    const { deps: overrides } = deps({ readFile: () => fixture('codex-models-cache.json') })
    const result = await discoverModels(preset('codex'), overrides)
    expect(result.models).not.toContain('gpt')
  })
})

describe('discoverModels — cli sources', () => {
  /**
   * Verbatim `kimi provider list --json`. The KEYS of the `models` table are the
   * ids `kimi --model <id>` accepts — the nested `model` field is the upstream
   * name behind the provider prefix and is NOT selectable on its own. The
   * previous generation read the same JSON the same way
   * (`vertragus-archiv/src/main/providers/models.ts`, parseKimiProviderListJson:
   * `Object.keys(parsed.models)`), which is the verified behaviour.
   */
  it('reads the Kimi model table from provider list --json by its keys', async () => {
    const exec = vi.fn(async () => fixture('kimi-provider-list.json'))
    const { deps: overrides } = deps({ exec })
    const result = await discoverModels(preset('kimi'), overrides)
    expect(exec).toHaveBeenCalledWith('kimi', ['provider', 'list', '--json'], 8_000)
    expect(result.models).toEqual([
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
      'kimi-code/k3',
      'kimi-code/k3-256k'
    ])
    expect(result.source).toBe('live')
    // The bare `model` field would launch nothing — it must not reach the picker.
    expect(result.models).not.toContain('kimi-for-coding')
    expect(result.models).not.toContain('managed:kimi-code')
  })

  it('reads the Cursor model list line by line', async () => {
    const exec = vi.fn(async () => 'Available models:\ncomposer-2.5\nauto\n')
    const { deps: overrides } = deps({ exec })
    const result = await discoverModels(preset('cursor'), overrides)
    expect(exec).toHaveBeenCalledWith('cursor-agent', ['models'], 8_000)
    expect(result.models).toEqual(['composer-2.5', 'auto'])
  })

  it('reads the full real cursor-agent catalogue', async () => {
    const { deps: overrides } = deps({ exec: async () => fixture('cursor-agent-models.txt') })
    const result = await discoverModels(preset('cursor'), overrides)
    expect(result.source).toBe('live')
    expect(result.models.length).toBeGreaterThan(150)
    expect(result.models).toContain('auto')
    expect(result.models).toContain('composer-2.5')
  })

  it('reports WHAT failed so the picker can say why it is empty', async () => {
    const { deps: overrides } = deps({
      exec: async () => {
        throw new Error('spawn cursor-agent ENOENT')
      }
    })
    const result = await discoverModels(preset('cursor'), overrides)
    expect(result.detail).toBe('cursor-agent models: spawn cursor-agent ENOENT')
    // The seed keeps the provider startable; the source says nothing was found.
    expect(result.models).toEqual(['auto'])
    expect(result.source).toBe('seed')
  })

  /**
   * The state a fresh machine is actually in: `cursor-agent --version` answers
   * (the provider shows as healthy) while `cursor-agent models` exits 1 because
   * nobody logged in. "Authentication required" alone is unactionable — the CLI
   * names its own binary (`agent login`), not the command Vertragus launches.
   */
  it('turns a login failure into the command that fixes it', async () => {
    const { deps: overrides } = deps({
      exec: async () => {
        throw new Error("Error: Authentication required. Run 'agent login', pass --api-key.")
      }
    })
    const result = await discoverModels(preset('cursor'), overrides)
    expect(result.detail).toBe(
      "cursor-agent models: nicht angemeldet — 'cursor-agent login' ausführen " +
        "(Error: Authentication required. Run 'agent login', pass --api-key.)"
    )
    expect(result.models).toEqual(['auto'])
  })

  it('reads the Grok model list line by line', async () => {
    const exec = vi.fn(async () => fixture('grok-models.txt'))
    const { deps: overrides } = deps({ exec })
    const result = await discoverModels(preset('grok'), overrides)
    expect(exec).toHaveBeenCalledWith('grok', ['models'], 8_000)
    expect(result.source).toBe('live')
    expect(result.models).toEqual(['grok-build', 'grok-4.6', 'grok-4.5', 'grok-4.3'])
  })

  it('keeps grok-build startable when grok models needs a login', async () => {
    const { deps: overrides } = deps({
      exec: async () => {
        throw new Error('Error: Authentication required. Run grok login or set XAI_API_KEY.')
      }
    })
    const result = await discoverModels(preset('grok'), overrides)
    expect(result.detail).toBe(
      'grok models: nicht angemeldet — \'grok login\' ausführen ' +
        '(Error: Authentication required. Run grok login or set XAI_API_KEY.)'
    )
    expect(result.models).toEqual(['grok-build'])
    expect(result.source).toBe('seed')
  })
})

describe('authFailureHint', () => {
  it.each([
    "Error: Authentication required. Run 'agent login'.",
    'Not logged in',
    'You are not authenticated',
    'Unauthorized',
    'Please sign in to continue',
    'invalid api key',
    'HTTP 401'
  ])('recognises %j as a missing login', (failure) => {
    expect(authFailureHint(preset('cursor'), failure)).toContain('nicht angemeldet')
  })

  it.each(['spawn cursor-agent ENOENT', 'keine Antwort binnen 8000 ms', 'HTTP 500'])(
    'leaves %j alone — it is not a login problem',
    (failure) => {
      expect(authFailureHint(preset('cursor'), failure)).toBeUndefined()
    }
  )

  /** A provider that declares no login flow can only state the fact. */
  it('falls back to the bare fact without declared login args', () => {
    const config = { ...preset('cursor'), auth: undefined }
    expect(authFailureHint(config, 'Not logged in')).toBe(
      'nicht angemeldet — bitte anmelden (Not logged in)'
    )
  })

  /** The hint lands inside an ENGLISH profile-editor sentence when ui.locale is en. */
  it('speaks the stored locale instead of gluing German into an English sentence', () => {
    expect(authFailureHint(preset('cursor'), 'Not logged in', 'en')).toMatch(
      /^not logged in — run '.+' \(Not logged in\)$/
    )
    const config = { ...preset('cursor'), auth: undefined }
    expect(authFailureHint(config, 'Not logged in', 'en')).toBe(
      'not logged in — please log in (Not logged in)'
    )
  })
})

describe('execProviderCli', () => {
  const platform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    execFileMock.calls.length = 0
    execFileMock.state.run = undefined
  })

  /** The shape Node attaches to an `execFile` rejection. */
  const execFailure = (fields: {
    stdout?: string
    stderr?: string
    killed?: boolean
    message?: string
  }): (() => Promise<never>) => {
    return async () => {
      throw Object.assign(new Error(fields.message ?? 'Command failed: cursor-agent models'), {
        stdout: fields.stdout ?? '',
        stderr: fields.stderr ?? '',
        killed: fields.killed ?? false
      })
    }
  }

  /**
   * On this machine `cursor-agent` is a PowerShell shim
   * (…\cursor-agent\cursor-agent.ps1) that `execFile` cannot start directly.
   * Discovery must go through `resolveLaunch`, exactly like the health probe —
   * a direct `execFile('cursor-agent', …)` would fail with ENOENT and the model
   * list would silently stay empty.
   */
  it('routes a Windows PowerShell shim through the resolved interpreter', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const stdout = await execProviderCli('cursor-agent', ['models'], 8_000)
    expect(execFileMock.calls[0]!.file).toBe('powershell.exe')
    expect(execFileMock.calls[0]!.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Users\\t\\AppData\\Local\\cursor-agent\\cursor-agent.ps1',
      'models'
    ])
    expect(parseLineModels(stdout)).toEqual(['auto', 'composer-2.5'])
  })

  it('starts a plain executable directly off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    await execProviderCli('kimi', ['provider', 'list'], 8_000)
    expect(execFileMock.calls[0]).toEqual({ file: 'kimi', args: ['provider', 'list'] })
  })

  /**
   * `execFile` rejects on any non-zero exit, and an exit code says nothing
   * about the output — a CLI can print its whole catalogue and still fail on a
   * background update check afterwards. Discarding that output would blank the
   * picker over a number.
   */
  it('keeps a completed run’s catalogue even when the CLI exits non-zero', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    execFileMock.state.run = execFailure({
      stdout: 'auto - Auto (default)\ncomposer-2.5 - Composer 2.5\n',
      stderr: 'update check failed'
    })
    const stdout = await execProviderCli('cursor-agent', ['models'], 8_000)
    expect(parseLineModels(stdout)).toEqual(['auto', 'composer-2.5'])
  })

  /**
   * A killed run is cut mid-write. Its last line can be a truncated id
   * (`claude-opus-5-hi`), which passes the id whitelist and would be offered as
   * a real model — so partial output is dropped, not salvaged.
   */
  it('drops a killed run’s partial output and reports the timeout', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    execFileMock.state.run = execFailure({
      stdout: 'auto - Auto (default)\nclaude-opus-5-hi',
      killed: true
    })
    await expect(execProviderCli('cursor-agent', ['models'], 8_000)).rejects.toThrow(
      'keine Antwort binnen 8000 ms'
    )
  })

  /**
   * What reaches the picker must be the CLI's own sentence. Node's message
   * wraps it in `Command failed: cmd.exe /c C:\…\cursor-agent.cmd models` — a
   * launch path the user never typed and cannot act on.
   */
  it('rejects with the CLI’s own line, not the Windows launch wrapper', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    execFileMock.state.run = execFailure({
      message:
        'Command failed: cmd.exe /c C:\\Users\\t\\cursor-agent.cmd models\nError: Authentication required.',
      stderr: "Error: Authentication required. Run 'agent login'.\n"
    })
    await expect(execProviderCli('cursor-agent', ['models'], 8_000)).rejects.toThrow(
      "Error: Authentication required. Run 'agent login'."
    )
  })

  it('falls back to the raw message when the CLI said nothing at all', () => {
    expect(cliFailureMessage(new Error('spawn cursor-agent ENOENT'), 8_000)).toBe(
      'spawn cursor-agent ENOENT'
    )
  })
})

describe('discoverModels — http sources', () => {
  it('reads the local Ollama tag list', async () => {
    const fetchJson = vi.fn(async () => JSON.parse(fixture('ollama-tags.json')))
    const { deps: overrides, written } = deps({ fetchJson })
    const result = await discoverModels(preset('ollama'), overrides)
    expect(fetchJson).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', 3_000)
    expect(result.models).toEqual(['qwen2.5-coder:32b', 'llama3.3:70b'])
    expect(result.source).toBe('live')
    // A locally deleted model cannot run — local catalogues are never remembered.
    expect(written).toEqual([])
  })

  it('returns nothing (not a stale memory) when the local service is down', async () => {
    const { deps: overrides } = deps({
      readMemory: () => ({ ollama: { 'llama3.3:70b': NOW } })
    })
    const result = await discoverModels(preset('ollama'), overrides)
    expect(result).toEqual({
      models: [],
      source: 'none',
      refreshedAt: NOW,
      detail: 'http://127.0.0.1:11434/api/tags: offline'
    })
  })
})

describe('discoverModels — memory layer', () => {
  it('serves the remembered catalogue when discovery finds nothing', async () => {
    const { deps: overrides } = deps({
      readMemory: () => ({ codex: { 'gpt-5.6-sol': NOW - 1_000, 'gpt-5.5': NOW - 1_000 } })
    })
    const result = await discoverModels(preset('codex'), overrides)
    expect(result.source).toBe('memory')
    expect(result.models).toEqual(['gpt-5.6-sol', 'gpt-5.5'])
  })

  it('puts the seeds behind a remembered catalogue instead of replacing it', async () => {
    const { deps: overrides } = deps({
      readMemory: () => ({ claude: { 'claude-opus-5': NOW - 1_000 } })
    })
    const result = await discoverModels(preset('claude'), overrides)
    expect(result.models).toEqual(['claude-opus-5', 'opus', 'sonnet', 'haiku'])
    expect(result.source).toBe('mixed')
  })

  it('forgets ids that have not been seen for 60 days', async () => {
    const { deps: overrides } = deps({
      readMemory: () => ({ codex: { ancient: NOW - MEMORY_TTL_MS - 1, 'gpt-5.5': NOW - 1 } })
    })
    const result = await discoverModels(preset('codex'), overrides)
    expect(result.models).toEqual(['gpt-5.5'])
  })

  it('records what it saw, keyed by provider id, without dropping other providers', async () => {
    const { deps: overrides, written } = deps({
      readFile: () => fixture('codex-models-cache.json'),
      readMemory: () => ({ kimi: { 'kimi-k3': NOW - 5 } })
    })
    await discoverModels(preset('codex'), overrides)
    expect(written).toHaveLength(1)
    expect(written[0]!.kimi).toEqual({ 'kimi-k3': NOW - 5 })
    expect(written[0]!.codex).toMatchObject({ 'gpt-5.6-sol': NOW })
  })

  it('never lets a failing memory write break a refresh', async () => {
    const { deps: overrides } = deps({
      readFile: () => fixture('codex-models-cache.json'),
      writeMemory: () => {
        throw new Error('read-only store')
      }
    })
    await expect(discoverModels(preset('codex'), overrides)).resolves.toMatchObject({
      source: 'live'
    })
  })

  it('ignores a corrupt memory value instead of crashing', () => {
    expect(normalizeModelMemory('nonsense')).toEqual({})
    expect(normalizeModelMemory({ claude: { opus: 'yesterday' } })).toEqual({})
    expect(normalizeModelMemory({ claude: { opus: 12 } })).toEqual({ claude: { opus: 12 } })
  })

  it('merges discovered and remembered ids and refreshes the timestamps', () => {
    const { models, seen } = applyModelMemory(['opus'], { sonnet: NOW - 10 }, NOW)
    expect(models).toEqual(['opus', 'sonnet'])
    expect(seen).toEqual({ opus: NOW, sonnet: NOW - 10 })
  })

  it('does not revive a remembered punctuation twin of a discovered id', () => {
    const { models } = applyModelMemory(
      ['claude-sonnet-4-6'],
      { 'claude-sonnet-4.6': NOW - 10 },
      NOW
    )
    expect(models).toEqual(['claude-sonnet-4-6'])
  })
})

describe('discoverModels — failure handling', () => {
  it('returns an empty result for a provider without discovery', async () => {
    // A seedless preset, so "empty" really means empty — Cursor now carries the
    // `auto` alias behind whatever discovery finds.
    const config = { ...preset('codex'), modelDiscovery: { kind: 'none' } as const }
    const { deps: overrides, written } = deps()
    expect(await discoverModels(config, overrides)).toEqual({
      models: [],
      source: 'none',
      refreshedAt: NOW
    })
    expect(written).toEqual([])
  })

  it('never throws when the CLI is missing or the cache is unreadable', async () => {
    const { deps: overrides } = deps()
    await expect(discoverModels(preset('kimi'), overrides)).resolves.toMatchObject({
      models: [],
      source: 'none',
      refreshedAt: NOW,
      detail: 'kimi provider list --json: exec not stubbed'
    })
    // Claude keeps its seeds — that is the whole point of them.
    await expect(discoverModels(preset('claude'), overrides)).resolves.toMatchObject({
      models: ['opus', 'sonnet', 'haiku'],
      source: 'seed'
    })
  })

  it('survives malformed JSON from a CLI', async () => {
    const { deps: overrides } = deps({ exec: async () => 'not json at all' })
    await expect(discoverModels(preset('kimi'), overrides)).resolves.toMatchObject({
      models: [],
      source: 'none',
      detail: 'kimi provider list --json: keine Modelle in der Antwort'
    })
  })
})

/**
 * The Finder/Dock launch on macOS. A GUI app inherits only
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so `execFile('claude', …)` is ENOENT while
 * Claude Code sits installed in `/opt/homebrew/bin` — and because this one
 * function backs the health probe, the auth probe and model discovery, the
 * first-run card would report "no CLI found" to a user who has one.
 *
 * CI can never catch that: every runner starts with a full PATH. These cases
 * are the only guard, so they drive the real mechanism — `process.env.PATH`
 * mutated by the refresh, exactly as `refreshProcessPathFromSystem` does it.
 */
describe('execProviderCli PATH recovery', () => {
  const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  const HOMEBREW = '/opt/homebrew/bin'
  const realPath = process.env['PATH']

  afterEach(() => {
    process.env['PATH'] = realPath
  })

  /** A CLI that only exists on the login shell's PATH, plus its call counters. */
  function homebrewCli(loginPath = `${FINDER_PATH}:${HOMEBREW}`): {
    runtime: Pick<ProviderCliRuntime, 'exec' | 'refreshPath'>
    counts: { exec: number; refresh: number }
  } {
    process.env['PATH'] = FINDER_PATH
    const counts = { exec: 0, refresh: 0 }
    return {
      counts,
      runtime: {
        exec: async () => {
          counts.exec += 1
          if (!(process.env['PATH'] ?? '').split(':').includes(HOMEBREW)) {
            throw Object.assign(new Error('spawn claude ENOENT'), {
              code: 'ENOENT',
              stdout: '',
              stderr: ''
            })
          }
          return { stdout: 'claude 2.1.0 (Claude Code)\n', stderr: '' }
        },
        refreshPath: async () => {
          counts.refresh += 1
          process.env['PATH'] = loginPath
        }
      }
    }
  }

  it('refreshes the login-shell PATH once on darwin and answers from the retry', async () => {
    const cli = homebrewCli()
    const stdout = await execProviderCli('claude', ['--version'], 6_000, 'en', {
      platform: 'darwin',
      ...cli.runtime
    })
    expect(stdout).toBe('claude 2.1.0 (Claude Code)\n')
    expect(cli.counts).toEqual({ exec: 2, refresh: 1 })
  })

  /**
   * The login-shell read costs a full shell startup, so it must stay a
   * recovery — a probe that succeeds may never pay for it.
   */
  it('does not touch the login shell when the command was found', async () => {
    const cli = homebrewCli()
    process.env['PATH'] = `${FINDER_PATH}:${HOMEBREW}`
    await execProviderCli('claude', ['--version'], 6_000, 'en', {
      platform: 'darwin',
      ...cli.runtime
    })
    expect(cli.counts).toEqual({ exec: 1, refresh: 0 })
  })

  /**
   * Windows resolves shims through `resolveLaunch` and Linux app launchers do
   * inherit the user's PATH; neither has a login shell to re-read, and both
   * would pay a shell startup per failed probe for nothing.
   */
  it.each(['win32', 'linux'] as const)('never refreshes on %s', async (platform) => {
    const cli = homebrewCli()
    await expect(
      execProviderCli('kimi', ['--version'], 6_000, 'en', { platform, ...cli.runtime })
    ).rejects.toThrow('spawn claude ENOENT')
    expect(cli.counts).toEqual({ exec: 1, refresh: 0 })
  })

  /**
   * A refreshed PATH that still misses means the CLI is genuinely not
   * installed. The user sees the error their command produced, not a second
   * one from an internal retry they never asked for.
   */
  it('surfaces the original error when the refreshed PATH still misses', async () => {
    const cli = homebrewCli(FINDER_PATH)
    await expect(
      execProviderCli('claude', ['--version'], 6_000, 'en', {
        platform: 'darwin',
        ...cli.runtime
      })
    ).rejects.toThrow('spawn claude ENOENT')
    expect(cli.counts).toEqual({ exec: 2, refresh: 1 })
  })

  /** Only a missing binary is a PATH problem — a CLI that ran and failed is not. */
  it('does not refresh when the CLI ran and exited non-zero', async () => {
    process.env['PATH'] = FINDER_PATH
    const counts = { exec: 0, refresh: 0 }
    await expect(
      execProviderCli('claude', ['--version'], 6_000, 'en', {
        platform: 'darwin',
        exec: async () => {
          counts.exec += 1
          throw Object.assign(new Error('Command failed: claude --version'), {
            code: 1,
            stdout: '',
            stderr: 'Error: Authentication required.\n'
          })
        },
        refreshPath: async () => {
          counts.refresh += 1
        }
      })
    ).rejects.toThrow('Error: Authentication required.')
    expect(counts).toEqual({ exec: 1, refresh: 0 })
  })
})
