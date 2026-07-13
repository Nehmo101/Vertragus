/**
 * Provider health probing. Detects whether each agent CLI / integration is
 * installed and reachable, plus a short status detail (auth, model count, ...).
 * Cross-platform: resolves executables via PATH (no hard-coded paths).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROVIDERS, type ProviderDef, type ProviderHealth } from '@shared/providers'
import { probeProviderConnection } from '@main/providers/auth'
import { refreshProcessPathFromSystem } from '@main/providers/processPath'

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

async function providerDetails(def: ProviderDef): Promise<Partial<ProviderHealth>> {
  const auth = await probeProviderConnection(def, run)
  let detail = auth.detail
  if (def.id === 'ollama') {
    try {
      const res = await fetch('http://localhost:11434/api/tags', {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      const data = (await res.json()) as { models?: unknown[] }
      detail = `${data.models?.length ?? 0} lokale Modelle · Cloud-Login optional`
    } catch {
      detail = 'CLI installiert; lokaler Dienst nicht erreichbar'
    }
  }
  return {
    connection: auth.connection,
    detail,
    canLogin: Boolean(def.auth),
    loginLabel: def.auth?.loginLabel
  }
}

export async function checkProvider(def: ProviderDef): Promise<ProviderHealth> {
  const base = { id: def.id, checkedAt: Date.now() }
  try {
    const version = firstLine(await run(def.command, def.versionArgs))
    return {
      ...base,
      available: true,
      version,
      ...(await providerDetails(def))
    }
  } catch (err) {
    return {
      ...base,
      available: false,
      connection: 'unknown',
      canLogin: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function checkAllProviders(): Promise<ProviderHealth[]> {
  await refreshProcessPathFromSystem()
  return Promise.all(PROVIDERS.map(checkProvider))
}
