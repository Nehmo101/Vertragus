/**
 * Provider health probing. Detects whether each agent CLI / integration is
 * installed and reachable, plus a short status detail (auth, model count, ...).
 * Cross-platform: resolves executables via PATH (no hard-coded paths).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROVIDERS, type ProviderDef, type ProviderHealth } from '@shared/providers'

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 6000

async function run(command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    // On Windows many CLIs are .cmd/.ps1 shims; shell lookup resolves them.
    shell: process.platform === 'win32'
  })
  return (stdout || stderr || '').trim()
}

/** First non-empty line of a command's output, trimmed. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ''
}

async function detail(def: ProviderDef): Promise<string | undefined> {
  try {
    if (def.id === 'github') {
      const out = await run('gh', ['auth', 'status'])
      const acct = out.match(/account\s+(\S+)/i)?.[1]
      return acct ? `Logged in as ${acct}` : firstLine(out)
    }
    if (def.id === 'ollama') {
      const res = await fetch('http://localhost:11434/api/tags', {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      const data = (await res.json()) as { models?: unknown[] }
      return `${data.models?.length ?? 0} model(s) available`
    }
  } catch {
    // Detail is best-effort; availability is decided by the version probe.
    return undefined
  }
  return undefined
}

export async function checkProvider(def: ProviderDef): Promise<ProviderHealth> {
  const base = { id: def.id, checkedAt: Date.now() }
  try {
    const version = firstLine(await run(def.command, def.versionArgs))
    return { ...base, available: true, version, detail: await detail(def) }
  } catch (err) {
    return {
      ...base,
      available: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function checkAllProviders(): Promise<ProviderHealth[]> {
  return Promise.all(PROVIDERS.map(checkProvider))
}
