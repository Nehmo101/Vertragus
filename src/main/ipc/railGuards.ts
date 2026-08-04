/**
 * Sender-Guards für die Rail-Kanäle (manifest auth 'custom'). Die Rail teilt
 * das Renderer-Preload mit allen Fenstern; ihre Steuerkanäle dürfen nur aus
 * dem Rail- oder Hauptfenster kommen — insbesondere NIE aus dem Voice-Overlay.
 */
export function guardRailControl(isRailWindow: boolean, isMainWindow: boolean): void {
  if (!isRailWindow && !isMainWindow) {
    throw new Error('Rail-Steuerung ist nur aus dem Rail- oder Hauptfenster erlaubt.')
  }
}
