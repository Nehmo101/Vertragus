/**
 * Login status — the probe `health.ts` deliberately leaves out, run only when
 * somebody is looking at it (the panel's first-run card).
 *
 * Three states and no fourth: `logged-in`, `logged-out`, and an `unknown` that
 * is a real answer rather than a placeholder. Half the shipped CLIs expose no
 * non-interactive status command at all (Kimi's device code flow, Grok's
 * browser OAuth, `ollama signin`), and guessing "probably fine" for those would
 * be exactly the kind of confident lie that sends a user hunting for a login
 * problem they do not have. A descriptor without `auth.statusArgs` therefore
 * reports `unknown` and says so.
 *
 * What we can honestly offer instead is the command: `auth.loginArgs` already
 * declares it per provider, composed here the same way {@link authFailureHint}
 * composes it for the model picker. Nothing in Vertragus drives that login —
 * these flows open browsers, print device codes and want a real terminal, and a
 * PTY puppet that types into them would break on the first prompt change.
 *
 * Reuses the discovery runner (Windows shim resolution) and the health probe's
 * timeout: a CLI that cannot answer a status question inside the window it gets
 * for `--version` is not going to answer it usefully later.
 */
import type { ProviderConfig } from '@shared/schema/provider'
import { AUTH_FAILURE_PATTERN, execProviderCli } from '@main/providers/discovery'
import { firstLine, HEALTH_TIMEOUT_MS } from '@main/providers/health'

export type ProviderAuthState = 'logged-in' | 'logged-out' | 'unknown'

export interface ProviderAuthStatus {
  id: string
  state: ProviderAuthState
  /**
   * The probe's own first line, or the error that replaced it. Absent when
   * there was nothing to run — the CLI declares no status probe.
   */
  detail?: string
  /**
   * `cursor-agent login`, ready to be typed. Absent when the descriptor
   * declares no login args; the card then offers no command rather than a
   * guessed one.
   */
  loginCommand?: string
  checkedAt: number
}

export interface AuthStatusDependencies {
  exec(command: string, args: string[], timeoutMs: number): Promise<string>
  now(): number
}

const defaultDependencies: AuthStatusDependencies = {
  exec: execProviderCli,
  now: () => Date.now()
}

/**
 * The login command exactly as the user must type it — the provider's own
 * executable, not the vendor's documented alias (`cursor-agent login`, never
 * `agent login`). Absent stays absent: a composed-from-nothing command would
 * be a command that does not exist.
 */
export function loginCommand(config: ProviderConfig): string | undefined {
  const args = config.auth?.loginArgs ?? []
  return args.length > 0 ? [config.command, ...args].join(' ') : undefined
}

/**
 * Classify one status probe's output.
 *
 * The sentence decides, never the exit code: `cursor-agent status` prints
 * "Not logged in" and exits 0, while `cursor-agent models` exits 1 on the same
 * account — which is why {@link AUTH_FAILURE_PATTERN} exists and why it is
 * shared with discovery instead of copied. Output that says nothing at all is
 * `unknown`: a status command that printed no line has not confirmed anything.
 */
export function classifyAuthOutput(output: string): ProviderAuthState {
  const line = firstLine(output)
  if (!line) return 'unknown'
  return AUTH_FAILURE_PATTERN.test(line) ? 'logged-out' : 'logged-in'
}

/**
 * Probe one provider. Never throws — a failed probe IS the result, same
 * contract as `checkProvider`.
 *
 * A thrown failure is read once more through the pattern: an ENOENT (CLI not
 * installed) says nothing about credentials and stays `unknown`, while a CLI
 * that exits non-zero with "Authentication required" has answered the question
 * it was asked.
 */
export async function checkProviderAuth(
  config: ProviderConfig,
  overrides: Partial<AuthStatusDependencies> = {}
): Promise<ProviderAuthStatus> {
  const deps = { ...defaultDependencies, ...overrides }
  const login = loginCommand(config)
  const base = {
    id: config.id,
    ...(login ? { loginCommand: login } : {})
  }
  const statusArgs = config.auth?.statusArgs
  if (!statusArgs || statusArgs.length === 0) {
    return { ...base, state: 'unknown', checkedAt: deps.now() }
  }

  try {
    const output = await deps.exec(config.command, statusArgs, HEALTH_TIMEOUT_MS)
    const line = firstLine(output)
    return {
      ...base,
      state: classifyAuthOutput(output),
      ...(line ? { detail: line } : {}),
      checkedAt: deps.now()
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.trim() : String(cause)
    return {
      ...base,
      state: AUTH_FAILURE_PATTERN.test(message) ? 'logged-out' : 'unknown',
      ...(message ? { detail: message } : {}),
      checkedAt: deps.now()
    }
  }
}

/** Probe every provider in parallel; one hanging CLI must not serialize the rest. */
export async function checkAllProviderAuth(
  configs: readonly ProviderConfig[],
  overrides: Partial<AuthStatusDependencies> = {}
): Promise<ProviderAuthStatus[]> {
  return Promise.all(configs.map((config) => checkProviderAuth(config, overrides)))
}
