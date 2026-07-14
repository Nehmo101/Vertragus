import { execFile } from 'node:child_process'

export type ProcessSignal = 'SIGTERM' | 'SIGKILL'
export const PROCESS_TERMINATION_GRACE_MS = 5_000

export function shouldCreateProcessGroup(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'win32'
}

/** Terminate a provider and every child process it spawned. */
export function terminateProcessTree(
  pid: number | undefined,
  fallbackKill: (signal: ProcessSignal) => void,
  signal: ProcessSignal = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
  ownsProcessGroup = false
): void {
  if (platform === 'win32') {
    if (!pid) {
      fallbackKill(signal)
      return
    }

    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) fallbackKill(signal)
    })
    return
  }

  if (pid && ownsProcessGroup) {
    try {
      // Only callers that created/own the child process group may use -pid.
      process.kill(-pid, signal)
      return
    } catch {
      // Fall back when the target has already exited or has no process group.
    }
  }
  fallbackKill(signal)
}

/**
 * Send SIGTERM and escalate only while the caller still owns the same process.
 * The ownership predicate prevents a delayed timer from targeting a reused PID.
 */
export function terminateProcessTreeWithEscalation(
  pid: number | undefined,
  fallbackKill: (signal: ProcessSignal) => void,
  isCurrentProcess: (expectedPid: number) => boolean,
  platform: NodeJS.Platform = process.platform,
  ownsProcessGroup = false,
  graceMs = PROCESS_TERMINATION_GRACE_MS
): () => void {
  terminateProcessTree(pid, fallbackKill, 'SIGTERM', platform, ownsProcessGroup)

  // taskkill /F already performs the established forced Windows tree shutdown.
  if (platform === 'win32' || !pid) return () => undefined

  const expectedPid = pid
  const escalation = setTimeout(() => {
    if (!isCurrentProcess(expectedPid)) return
    terminateProcessTree(expectedPid, fallbackKill, 'SIGKILL', platform, ownsProcessGroup)
  }, graceMs)
  escalation.unref()
  return () => clearTimeout(escalation)
}
