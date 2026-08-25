/**
 * Point Electron's userData at an isolated directory for smokes and other
 * throwaway boots. Must run before `app.whenReady()` — constructing the
 * settings store binds `app.getPath('userData')` and would otherwise write
 * `vertragus-v2.json` into the developer's real AppData.
 *
 * Inert without {@link USER_DATA_ENV}. Production Play never sets it.
 */
import { app } from 'electron'

/** Absolute directory that becomes `app.getPath('userData')`. */
export const USER_DATA_ENV = 'VERTRAGUS_USER_DATA'

export type IsolatedUserDataName = 'userData' | 'sessionData'

/**
 * Apply {@link USER_DATA_ENV} to Electron's path table. Returns the directory
 * when it did something, otherwise undefined.
 */
export function applyIsolatedUserData(
  env: NodeJS.ProcessEnv = process.env,
  setPath: (name: IsolatedUserDataName, value: string) => void = (name, value) =>
    app.setPath(name, value)
): string | undefined {
  const dir = env[USER_DATA_ENV]?.trim()
  if (!dir) return undefined
  setPath('userData', dir)
  setPath('sessionData', dir)
  return dir
}
