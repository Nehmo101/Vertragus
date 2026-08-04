import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@renderer/store/useAppStore'
import { railTiles } from './railTiles'
import '@renderer/assets/rail.css'

/**
 * Die Desktop-Rail (#/sidebar): schmale Always-on-top-Startleiste. Sie spiegelt
 * den Store nur (Profil-Liste, Agenten, Sessions kommen via ev:-Broadcasts)
 * und schreibt ausschliesslich via IPC-Actions — nie direkt in geteilten State.
 *
 * Verschieben: native OS-Drag ueber -webkit-app-region auf der ganzen Flaeche
 * (Snap + Persistenz uebernimmt der Main-Prozess im 'moved'-Event). Der Weg
 * zurueck zur Vollansicht ist mehrfach vorhanden: Header-Button, Footer-Button,
 * Empty-State-Button und der Tray-Eintrag. ✕ schliesst die Rail (als letztes
 * Fenster beendet das Vertragus).
 */
export default function RailWindow(): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore(
    useShallow((s) => ({
      profiles: s.profiles,
      agents: s.agents,
      workspaceSessions: s.workspaceSessions,
      bootstrapped: s.bootstrapped,
      yoloMaster: s.yoloMaster,
      toggleYolo: s.toggleYolo
    }))
  )
  const tiles = useMemo(
    () => railTiles(store.profiles, store.agents, store.workspaceSessions),
    [store.profiles, store.agents, store.workspaceSessions]
  )
  /** Profil-IDs mit laufendem launchTiled-Aufruf (Spinner, Doppelklick-Schutz). */
  const [launching, setLaunching] = useState<Record<string, boolean>>({})
  /** Letzter Startfehler — stilles Scheitern ist das Frustrierendste an einem Launcher. */
  const [error, setError] = useState<string | null>(null)
  /** Zweistufiges Stoppen: erster Klick armiert, zweiter fuehrt aus. */
  const [confirmStop, setConfirmStop] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(confirmTimer.current), [])

  const openMain = (): void => {
    void window.vertragus.rail.openMain()
  }

  const launch = async (profileId: string): Promise<void> => {
    if (launching[profileId]) return
    setError(null)
    setLaunching((state) => ({ ...state, [profileId]: true }))
    try {
      await window.vertragus.rail.launchTiled(profileId, useAppStore.getState().yoloMaster)
    } catch (raw) {
      const message = raw instanceof Error ? raw.message : String(raw)
      // Electron prefixt IPC-Fehler mit "Error invoking remote method …: Error:".
      setError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
    } finally {
      setLaunching((state) => {
        const next = { ...state }
        delete next[profileId]
        return next
      })
    }
  }

  const stop = (profileId: string): void => {
    clearTimeout(confirmTimer.current)
    if (confirmStop !== profileId) {
      setConfirmStop(profileId)
      confirmTimer.current = setTimeout(() => setConfirmStop(null), 3000)
      return
    }
    setConfirmStop(null)
    setError(null)
    window.vertragus.agents.clean(profileId).catch((raw: unknown) => {
      const message = raw instanceof Error ? raw.message : String(raw)
      setError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
    })
  }

  return (
    <main className="rail" aria-label={t('rail.title')} title={t('rail.dragAria')}>
      <header className="rail-head">
        <div className="rail-orb" aria-hidden="true">
          ◆
        </div>
        <div className="rail-brand">
          <span className="rail-brand-name">VERTRAGVS</span>
          <span className="rail-brand-sub">{t('rail.subtitle')}</span>
        </div>
        <button
          type="button"
          className="rail-open-main"
          title={t('rail.full')}
          aria-label={t('rail.full')}
          onClick={openMain}
        >
          ⛶
        </button>
        <button
          type="button"
          className="rail-close"
          title={t('rail.close')}
          aria-label={t('rail.close')}
          onClick={() => window.vertragus.win.close()}
        >
          ✕
        </button>
      </header>

      {error && (
        <div className="rail-error" role="alert">
          <span className="rail-error-text">{error}</span>
          <button
            type="button"
            className="rail-error-dismiss"
            aria-label={t('rail.errorDismiss')}
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      <div className="rail-profiles" role="list">
        {tiles.map((tile) => {
          const isLaunching = Boolean(launching[tile.id])
          return (
            <div key={tile.id} role="listitem" className="rail-row">
              <button
                type="button"
                className={`rail-tile${tile.active ? ' active' : ''}${isLaunching ? ' launching' : ''}`}
                disabled={isLaunching}
                title={
                  isLaunching
                    ? t('rail.launching', { name: tile.name })
                    : tile.runningAgents > 0
                      ? t('rail.running', { name: tile.name, count: tile.runningAgents })
                      : t('rail.launch', { name: tile.name })
                }
                onClick={() => void launch(tile.id)}
              >
                <span className="rail-tile-initial" aria-hidden="true">
                  {isLaunching ? <span className="rail-spinner" /> : tile.initial}
                </span>
                <span className="rail-tile-name">{tile.name}</span>
                {tile.runningAgents > 0 ? (
                  <span className="rail-tile-badge">{tile.runningAgents}</span>
                ) : (
                  <span className="rail-tile-go" aria-hidden="true">
                    ▶
                  </span>
                )}
              </button>
              {tile.runningAgents > 0 && !isLaunching && (
                <button
                  type="button"
                  className={`rail-stop${confirmStop === tile.id ? ' confirm' : ''}`}
                  title={
                    confirmStop === tile.id
                      ? t('rail.stopConfirm', { name: tile.name })
                      : t('rail.stop', { name: tile.name })
                  }
                  aria-label={
                    confirmStop === tile.id
                      ? t('rail.stopConfirm', { name: tile.name })
                      : t('rail.stop', { name: tile.name })
                  }
                  onClick={() => stop(tile.id)}
                >
                  {confirmStop === tile.id ? '✓?' : '■'}
                </button>
              )}
            </div>
          )
        })}
        {tiles.length === 0 && (
          <div className="rail-empty">
            <p>{store.bootstrapped ? t('rail.empty') : t('rail.loading')}</p>
            {store.bootstrapped && (
              <button type="button" className="rail-empty-action" onClick={openMain}>
                {t('rail.emptyAction')}
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="rail-footer">
        <button
          type="button"
          className={`rail-action yolo${store.yoloMaster ? ' on' : ''}`}
          title={store.yoloMaster ? t('app.yoloBanner.disable') : t('app.safeMode.enable')}
          aria-pressed={store.yoloMaster}
          onClick={store.toggleYolo}
        >
          <span className="rail-action-icon" aria-hidden="true">
            ⚡
          </span>
          <span className="rail-action-label">
            {store.yoloMaster ? t('rail.yoloOn') : t('rail.yoloOff')}
          </span>
        </button>
        <button type="button" className="rail-action" title={t('rail.full')} onClick={openMain}>
          <span className="rail-action-icon" aria-hidden="true">
            ⛶
          </span>
          <span className="rail-action-label">{t('rail.full')}</span>
        </button>
      </footer>
    </main>
  )
}
