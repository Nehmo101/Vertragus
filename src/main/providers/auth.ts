import type { ProviderDef, ProviderHealth, ProviderId } from '@shared/providers'

export type AuthCommandRunner = (command: string, args: string[]) => Promise<string>

export interface ProviderConnectionProbe {
  connection: NonNullable<ProviderHealth['connection']>
  detail?: string
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

export function parseProviderAuthStatus(id: ProviderId, output: string): ProviderConnectionProbe {
  if (id === 'claude') {
    try {
      const parsed = JSON.parse(output) as {
        loggedIn?: boolean
        email?: string
        authMethod?: string
      }
      return {
        connection: parsed.loggedIn ? 'connected' : 'disconnected',
        detail: parsed.loggedIn
          ? [parsed.email, parsed.authMethod].filter(Boolean).join(' · ')
          : 'Nicht angemeldet'
      }
    } catch {
      return { connection: 'unknown', detail: firstLine(output) }
    }
  }

  if (id === 'codex') {
    const connected = /logged in/i.test(output) && !/not logged in/i.test(output)
    return {
      connection: connected ? 'connected' : 'disconnected',
      detail: firstLine(output) || (connected ? 'Angemeldet' : 'Nicht angemeldet')
    }
  }

  if (id === 'cursor') {
    const connected = /login successful|logged in/i.test(output) && !/not logged in/i.test(output)
    return {
      connection: connected ? 'connected' : 'disconnected',
      detail: firstLine(output) || (connected ? 'Angemeldet' : 'Nicht angemeldet')
    }
  }

  if (id === 'github') {
    const account = output.match(/account\s+(\S+)/i)?.[1]
    return {
      connection: /logged in/i.test(output) ? 'connected' : 'disconnected',
      detail: account ? `Angemeldet als ${account}` : firstLine(output)
    }
  }

  return { connection: 'unknown', detail: firstLine(output) }
}

export async function probeProviderConnection(
  def: ProviderDef,
  run: AuthCommandRunner
): Promise<ProviderConnectionProbe> {
  if (def.id === 'ollama') {
    return { connection: 'local', detail: 'Lokaler Dienst; Cloud-Login optional' }
  }
  if (!def.auth?.statusArgs) {
    return {
      connection: 'unknown',
      detail: def.auth ? 'Login-Status nicht automatisch prüfbar' : undefined
    }
  }
  try {
    return parseProviderAuthStatus(def.id, await run(def.command, def.auth.statusArgs))
  } catch {
    return { connection: 'disconnected', detail: 'Nicht angemeldet' }
  }
}
