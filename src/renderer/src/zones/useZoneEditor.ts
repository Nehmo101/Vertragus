/**
 * State of one zone overlay window.
 *
 * The window covers exactly one display's work area, so the editor works in
 * plain CSS pixels and only converts to the stored relative form on save. Every
 * change also pushes a DRAFT to main: whichever overlay the user finally clicks
 * "save" in persists the layout of ALL displays, and it can only do that if the
 * others have already told main what they are showing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ZoneEditorPayload, ZoneEditorRole } from '../../../preload'
import { applyLocale } from '../i18n'
import { errorText } from '../lib/ipcError'
import { demoZoneEditorPayload } from './demoPayload'
import {
  clampMove,
  clampResize,
  draftsToZones,
  newZoneRect,
  relToPx,
  type DraftZone,
  type PxRect,
  type Viewport
} from './geometry'

export interface ZoneEditorState {
  ready: boolean
  profileName: string
  displayId: number
  viewport: Viewport
  roles: ZoneEditorRole[]
  zones: DraftZone[]
  error: string | null
  saving: boolean
  demo: boolean
  addZone(roleId: string): void
  removeZone(id: string): void
  moveZone(id: string, rect: PxRect): void
  resizeZone(id: string, rect: PxRect): void
  /** Called at the end of a gesture — main only needs the settled rectangles. */
  commit(): void
  save(): void
  cancel(): void
}

export interface UseZoneEditorInput {
  displayId: number
  demo?: boolean
}

function viewportNow(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** Fallback accent for a zone whose role has since been removed from the profile. */
const ORPHAN_COLOR = '#8c8069'

/** Loaded zones → editable rectangles, with local keys from `offset` upwards. */
function toDrafts(loaded: ZoneEditorPayload, viewport: Viewport, offset: number): DraftZone[] {
  return loaded.zones.map((zone, index) => {
    const role = loaded.roles.find((entry) => entry.roleId === zone.roleId)
    return {
      id: `z${offset + index + 1}`,
      roleId: zone.roleId,
      label: role?.label ?? zone.roleId,
      color: role?.color ?? ORPHAN_COLOR,
      rect: relToPx(zone.rect, viewport)
    }
  })
}

export function useZoneEditor({ displayId, demo = false }: UseZoneEditorInput): ZoneEditorState {
  const { t } = useTranslation()
  const bridge = useMemo(() => window.vertragus?.zones, [])
  /**
   * The overlay is not resizable, so its work area is fixed for the lifetime of
   * the window — a constant, not state that could go stale mid-drag.
   */
  const viewport = useMemo<Viewport>(() => viewportNow(), [])
  // The demo layout (screenshot hook) needs no round trip: it is the initial
  // state, which also keeps the load effect free of a synchronous setState.
  const seed = useMemo(() => (demo ? demoZoneEditorPayload(displayId) : null), [demo, displayId])
  const [payload, setPayload] = useState<ZoneEditorPayload | null>(seed)
  const [zones, setZones] = useState<DraftZone[]>(() =>
    seed ? toDrafts(seed, viewportNow(), 0) : []
  )
  const [error, setError] = useState<string | null>(
    bridge || demo ? null : t('common.bridgeMissing')
  )
  const [saving, setSaving] = useState(false)
  /** Monotonic counter for local zone keys and the new-zone cascade. */
  const created = useRef(seed ? seed.zones.length : 0)

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    if (demo || !bridge) return undefined
    let alive = true
    bridge.load().then(
      (loaded) => {
        if (!alive) return
        // An overlay may not call `settings:get`, so this payload is the only
        // place its language can come from (see appIpc's zones:load handler).
        void applyLocale(loaded.locale)
        setPayload(loaded)
        setZones(toDrafts(loaded, viewport, created.current))
        created.current += loaded.zones.length
      },
      (cause) => {
        if (alive) setError(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, demo, viewport])

  // --- Esc closes the whole session, saving nothing ------------------------
  const cancel = useCallback(() => {
    bridge?.cancel()
  }, [bridge])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  const commit = useCallback(() => {
    if (!bridge || demo) return
    bridge.draft(draftsToZones(zones, displayId, viewport))
  }, [bridge, demo, displayId, viewport, zones])

  return {
    ready: payload !== null,
    profileName: payload?.profileName ?? '',
    displayId,
    viewport,
    roles: payload?.roles ?? [],
    zones,
    error,
    saving,
    demo,

    addZone(roleId) {
      const role = payload?.roles.find((entry) => entry.roleId === roleId)
      if (!role) return
      created.current += 1
      setZones((current) => [
        ...current,
        {
          id: `z${created.current}`,
          roleId: role.roleId,
          label: role.label,
          color: role.color,
          rect: newZoneRect(viewport, current.length)
        }
      ])
    },

    removeZone(id) {
      setZones((current) => current.filter((zone) => zone.id !== id))
    },

    moveZone(id, rect) {
      setZones((current) =>
        current.map((zone) => (zone.id === id ? { ...zone, rect: clampMove(rect, viewport) } : zone))
      )
    },

    resizeZone(id, rect) {
      setZones((current) =>
        current.map((zone) =>
          zone.id === id
            ? { ...zone, rect: clampMove(clampResize(rect, viewport), viewport) }
            : zone
        )
      )
    },

    commit,

    save() {
      if (demo) return
      if (!bridge || !payload) {
        setError(t('common.bridgeMissing'))
        return
      }
      setSaving(true)
      setError(null)
      bridge.save(payload.profileId, draftsToZones(zones, displayId, viewport)).then(
        () => {
          // The overlay closes from main; nothing left to do here.
        },
        (cause) => {
          setSaving(false)
          setError(errorText(cause))
        }
      )
    },

    cancel
  }
}
