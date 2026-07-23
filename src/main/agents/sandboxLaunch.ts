/**
 * Opt-in OS sandbox (bubblewrap) for headless Yolo workers — Linux only.
 *
 * Yolo workers run their provider CLI with --dangerously-skip-permissions (or
 * the provider's equivalent), so worktree isolation protects the repository
 * but nothing stops a runaway process from writing anywhere the user can.
 * When a workspace profile opts in (`sandbox: 'bwrap'`), the resolved launch
 * is wrapped in bwrap(1): the whole filesystem is mounted read-only and only
 * the worker's worktree, the run's temp/runtime dir and the provider
 * config/cache paths under $HOME stay writable.
 *
 * Deliberate non-goals: the network stays ON (the worker must reach its
 * provider API) and the user namespace is NOT unshared (`--unshare-user`
 * breaks setuid bwrap builds and kernels without unprivileged user
 * namespaces). This is an accident barrier, not a full trust boundary.
 *
 * Pure module: wrapWithBwrap/applySandbox only build argv; the sole side
 * effect is the cached `bwrap --version` availability probe.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { SandboxMode } from '@shared/profile'

export type { SandboxMode }

/** Command + argv exactly as handed to child_process.spawn. */
export interface SandboxLaunch {
  file: string
  args: string[]
}

export interface BwrapWrapOptions {
  /** The worker's worktree — the only repository path that stays writable. */
  workingDir: string
  /** The user's home directory (os.homedir()), base of SANDBOX_RW_HOME_PATHS. */
  homeDir: string
  /**
   * Per-run temp/runtime dir that must stay shared with the parent process
   * (e.g. the codex last-message dir headless.ts reads after exit). Bound RW
   * AFTER `--tmpfs /tmp`, so it stays visible even when it lives under /tmp.
   */
  tempDir?: string
}

/**
 * $HOME paths that stay writable (RW) inside the sandbox. The provider CLIs
 * update sessions, OAuth/refresh tokens and caches there on every run —
 * mounting them read-only would break logins mid-run. Bound via `--bind-try`,
 * so entries that do not exist on this machine are simply skipped.
 */
export const SANDBOX_RW_HOME_PATHS: readonly string[] = [
  '.claude', // Claude Code: Sessions, Projekt-State, Token-Refresh
  '.claude.json', // Claude Code: globale State-Datei (wird pro Run aktualisiert)
  '.codex', // Codex CLI: auth.json, Sessions/Rollouts
  '.kimi', // Kimi CLI (spiegelt Claude Codes Layout)
  '.cursor', // cursor-agent: Auth + CLI-State
  '.copilot', // GitHub Copilot CLI: Konfiguration + Token-Cache
  '.config', // XDG-Konfiguration (git, gh, Provider-CLIs)
  '.cache' // XDG-Caches (Downloads, Modell-/Versions-Metadaten)
]

/** German launch-abort message when the profile demands bwrap but it is missing. */
export const BWRAP_MISSING_MESSAGE =
  'OS-Sandbox ist im Profil aktiviert, aber bubblewrap (bwrap) ist nicht installiert. ' +
  'Bitte bubblewrap installieren (z. B. `sudo apt install bubblewrap`) oder die Sandbox ' +
  "im Workspace-Profil auf 'none' stellen. Der Worker startet nicht ohne Sandbox."

let availabilityProbe: Promise<boolean> | undefined

/**
 * Probe `bwrap --version` once and cache a positive result for the process
 * lifetime. A negative result is NOT cached, so installing bubblewrap takes
 * effect on the next run without restarting Vertragus.
 */
export function bwrapAvailable(): Promise<boolean> {
  if (!availabilityProbe) {
    availabilityProbe = new Promise<boolean>((resolve) => {
      execFile('bwrap', ['--version'], { timeout: 5_000, windowsHide: true }, (error) => {
        resolve(!error)
      })
    }).then((available) => {
      if (!available) availabilityProbe = undefined
      return available
    })
  }
  return availabilityProbe
}

/** Test seam: forget the cached availability probe. */
export function resetBwrapAvailabilityForTests(): void {
  availabilityProbe = undefined
}

/**
 * Build the bwrap command line around an already resolved launch. Pure and
 * deterministic — callers gate on platform/availability (see runHeadless).
 *
 * Mount order matters: `--ro-bind / /` first, then fresh /dev, /proc and a
 * private tmpfs /tmp, then every RW bind — later binds win in bwrap, so the
 * worktree and temp dir stay writable even if they live under /tmp.
 */
export function wrapWithBwrap(launch: SandboxLaunch, opts: BwrapWrapOptions): SandboxLaunch {
  const rwHomeBinds = SANDBOX_RW_HOME_PATHS.flatMap((relative) => {
    const absolute = join(opts.homeDir, relative)
    return ['--bind-try', absolute, absolute]
  })
  const args = [
    // Ganze Wurzel sichtbar, aber read-only: node, git, /etc, CA-Zertifikate.
    '--ro-bind', '/', '/',
    // Frische /dev- und /proc-Instanzen passend zum neuen PID-Namespace.
    '--dev', '/dev',
    '--proc', '/proc',
    // Privates, beschreibbares /tmp; nichts landet im Host-/tmp.
    '--tmpfs', '/tmp',
    // Einzige beschreibbare Repo-Sicht: der Worktree des Workers.
    '--bind', opts.workingDir, opts.workingDir,
    // Run-Temp-Verzeichnis, das der Elternprozess nach dem Exit lesen muss.
    ...(opts.tempDir ? ['--bind', opts.tempDir, opts.tempDir] : []),
    ...rwHomeBinds,
    '--chdir', opts.workingDir,
    // PID-Namespace isolieren; Netzwerk-Namespace bewusst NICHT (Provider-APIs)
    // und --unshare-user bewusst NICHT (setuid-bwrap-Kompatibilität).
    '--unshare-pid',
    '--die-with-parent',
    '--',
    launch.file,
    ...launch.args
  ]
  return { file: 'bwrap', args }
}

/** Wrap only for 'bwrap'; 'none' (or an omitted legacy value) is a strict no-op. */
export function applySandbox(
  launch: SandboxLaunch,
  sandbox: SandboxMode | undefined,
  opts: BwrapWrapOptions
): SandboxLaunch {
  return sandbox === 'bwrap' ? wrapWithBwrap(launch, opts) : launch
}
