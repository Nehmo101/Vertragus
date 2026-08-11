/**
 * Turn a rejected IPC call into a line a user can read.
 *
 * Electron wraps a main-process throw as
 * `Error invoking remote method 'profiles:save': Error: <message>`. The wrapper
 * names an internal channel and says nothing to the person in front of the
 * screen; the message after it is the part that was written for them.
 */
export function errorText(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}
