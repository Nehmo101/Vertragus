import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@renderer/store/useAppStore'
import { railTiles } from './railTiles'
import '@renderer/assets/rail.css'

interface DragStart {
  pointerX: number
  pointerY: number
  windowX: number
  windowY: number
  moved: boolean
}

/**
 * Die Desktop-Rail (#/sidebar): schmale Always-on-top-Startleiste. Sie spiegelt
 * den Store nur (Profil-Liste, Agenten, Sessions kommen via ev:-Broadcasts)
 * und schreibt ausschliesslich via IPC-Actions — nie direkt in geteilten State.
 *
 * Der Weg zurueck zur Vollansicht ist bewusst mehrfach vorhanden: Header-Button,
 * Doppelklick auf den Orb, Empty-State-Button und der Tray-Eintrag im Main.
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
  const dragRef = useRef<DragStart | null>(null)
  const tiles = useMemo(
    () => railTiles(store.profiles, store.agents, store.workspaceSessions),
    [store.profiles, store.agents, store.workspaceSessions]
  )

  const openMain = (): void => {
    void window.vertragus.rail.openMain()
  }

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerX: event.screenX,
      pointerY: event.screenY,
      windowX: window.screenX,
      windowY: window.screenY,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const drag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current
    if (!start) return
    const dx = event.screenX - start.pointerX
    const dy = event.screenY - start.pointerY
    if (!start.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    start.moved = true
    window.vertragus.rail.moved(Math.round(start.windowX + dx), Math.round(start.windowY + dy))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <main className="rail" aria-label={t('rail.title')}>
      <header className="rail-head">
        <div
          className="rail-orb"
          role="button"
          tabIndex={0}
          title={t('rail.dragAria')}
          aria-label={t('rail.dragAria')}
          onPointerDown={beginDrag}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onDoubleClick={openMain}
        >
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
      </header>

      <div className="rail-profiles" role="list">
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            role="listitem"
            className={`rail-tile${tile.active ? ' active' : ''}`}
            title={
              tile.runningAgents > 0
                ? t('rail.running', { name: tile.name, count: tile.runningAgents })
                : t('rail.launch', { name: tile.name })
            }
            onClick={() => {
              void window.vertragus.rail.launchTiled(tile.id, useAppStore.getState().yoloMaster)
            }}
          >
            <span className="rail-tile-initial" aria-hidden="true">
              {tile.initial}
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
        ))}
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
