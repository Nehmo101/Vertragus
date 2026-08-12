import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { DraftZone, PxRect } from './geometry'
import { useZoneEditor, type ZoneEditorState } from './useZoneEditor'
import './zones.css'

/**
 * The zone overlay — one transparent full-screen sheet per monitor.
 *
 * Everything on this surface is drawn ON the desktop it configures: the
 * rectangles are the actual screen regions, at actual size. Chrome is kept to
 * two floating slabs (a hint pill at the top, the palette and the two buttons
 * at the bottom) so the rectangles stay the loudest thing on screen.
 *
 * Dragging uses pointer capture rather than window listeners: the gesture keeps
 * following the mouse even when it leaves the rectangle, and it ends cleanly
 * when the button is released outside the window.
 */

interface Gesture {
  id: string
  mode: 'move' | 'resize'
  pointerX: number
  pointerY: number
  rect: PxRect
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value
  const int = Number.parseInt(full, 16)
  if (Number.isNaN(int)) return hex
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

function ZoneRect({
  zone,
  editor,
  gestureRef
}: {
  zone: DraftZone
  editor: ZoneEditorState
  gestureRef: React.MutableRefObject<Gesture | null>
}): React.JSX.Element {
  const { t } = useTranslation()
  const start = (event: React.PointerEvent, mode: Gesture['mode']): void => {
    event.preventDefault()
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    gestureRef.current = {
      id: zone.id,
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      rect: zone.rect
    }
  }

  const move = (event: React.PointerEvent): void => {
    const active = gestureRef.current
    if (!active || active.id !== zone.id) return
    const dx = event.clientX - active.pointerX
    const dy = event.clientY - active.pointerY
    if (active.mode === 'move') {
      editor.moveZone(zone.id, { ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy })
    } else {
      editor.resizeZone(zone.id, {
        ...active.rect,
        width: active.rect.width + dx,
        height: active.rect.height + dy
      })
    }
  }

  const end = (event: React.PointerEvent): void => {
    if (!gestureRef.current || gestureRef.current.id !== zone.id) return
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    gestureRef.current = null
    editor.commit()
  }

  return (
    <div
      className="zone"
      style={{
        left: zone.rect.x,
        top: zone.rect.y,
        width: zone.rect.width,
        height: zone.rect.height,
        borderColor: zone.color,
        background: withAlpha(zone.color, 0.14),
        boxShadow: `0 0 0 1px ${withAlpha(zone.color, 0.35)}, 0 18px 40px rgba(0, 0, 0, 0.45)`
      }}
      onPointerDown={(event) => start(event, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="zone-chip" style={{ background: withAlpha(zone.color, 0.9) }}>
        <span className="zone-chip-label">{zone.label}</span>
        <button
          type="button"
          className="zone-chip-remove"
          title={t('zones.removeZone', { role: zone.label })}
          aria-label={t('zones.removeZone', { role: zone.label })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => editor.removeZone(zone.id)}
        >
          ×
        </button>
      </span>
      <span
        className="zone-handle"
        style={{ borderColor: zone.color }}
        onPointerDown={(event) => start(event, 'resize')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}

export function ZonesApp({
  displayId,
  demo = false
}: {
  displayId: number
  demo?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const editor = useZoneEditor({ displayId, demo })
  const gestureRef = useRef<Gesture | null>(null)

  return (
    <div className="zones">
      <div className="zones-wash" />

      <div className="zones-hint">
        <span className="zones-hint-title">
          {editor.ready ? t('zones.title', { profile: editor.profileName }) : t('common.loading')}
        </span>
        <span className="zones-hint-text">{t('zones.hint')}</span>
        <span className="zones-hint-meta">
          {t('zones.display', { width: editor.viewport.width, height: editor.viewport.height })}
          {editor.demo ? ` · ${t('zones.demoBadge')}` : ''}
        </span>
      </div>

      {editor.zones.map((zone) => (
        <ZoneRect key={zone.id} zone={zone} editor={editor} gestureRef={gestureRef} />
      ))}

      {editor.ready && editor.zones.length === 0 ? (
        <p className="zones-empty">{t('zones.empty')}</p>
      ) : null}

      <div className="zones-bar">
        <span className="zones-bar-label">{t('zones.palette')}</span>
        <div className="zones-palette">
          {editor.roles.map((role) => (
            <button
              key={role.roleId}
              type="button"
              className="zones-role"
              style={{ borderColor: withAlpha(role.color, 0.55), color: role.color }}
              onClick={() => editor.addZone(role.roleId)}
            >
              {t('zones.addZone', { role: role.label })}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="zones-ghost"
          onClick={editor.autoLayout}
          disabled={!editor.ready || editor.roles.length === 0}
        >
          {t('zones.autoLayout')}
        </button>
        <span className="zones-bar-spacer" />
        {editor.error ? <span className="zones-error">{editor.error}</span> : null}
        <button type="button" className="zones-ghost" onClick={editor.cancel}>
          {t('zones.cancel')}
        </button>
        <button
          type="button"
          className="zones-primary"
          onClick={editor.save}
          disabled={editor.saving || !editor.ready}
        >
          {editor.saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
