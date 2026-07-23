import { brandEnv } from '@main/env'

/**
 * Headless host mode (VERTRAGUS_HEADLESS=1): the full engine — MCP server,
 * agent manager, session restore and the Mission-Control gateway — runs
 * without any window, tray, shortcut or updater surface. Control happens
 * exclusively through the remote gateway (roadmap "Detach-Persistenz",
 * step 1: VPS/daemon operation).
 */
export function isHeadlessMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = brandEnv('HEADLESS', env)
  return value === '1' || value === 'true'
}

/** Startup log lines for the headless host, warning when it is unreachable. */
export function headlessStartupLines(remoteEnabled: boolean): string[] {
  const lines = [
    '[Headless] Vertragus läuft ohne Fenster; Engine, MCP-Server und Agents sind aktiv.'
  ]
  if (remoteEnabled) {
    lines.push('[Headless] Steuerung über das Mission-Control-Gateway (gepairte Geräte).')
  } else {
    lines.push(
      '[Headless] WARNUNG: Mission Control ist nicht aktiviert — dieser Host ist nicht fernsteuerbar. ' +
        'Remote-Zugriff zuerst in der Desktop-App aktivieren, dann headless starten.'
    )
  }
  return lines
}
