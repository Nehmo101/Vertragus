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
import { applyTheme } from '../theme'
import { errorText } from '../lib/ipcError'
import { demoZoneEditorPayload } from './demoPayload'
import { autoLayoutDrafts } from './autoLayout'
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
  /** True while this overlay is the multi-monitor picker. */
  selectingDisplay: boolean
  displayLabel: string
  displayPrimary: boolean
  displayCount: number
  displays: ZoneEditorPayload['displays']
  addZone(roleId: string): void
  removeZone(id: string): void
  moveZone(id: string, rect: PxRect): void
  resizeZone(id: string, rect: PxRect): void
  /** Replace drafts with an auto-layout of the palette roles (not persisted until save). */
  autoLayout(): void
  /** Called at the end of a gesture — main only needs the settled rectangles. */
  commit(): void
  /** Pin Vertragus to this monitor, then edit zones on it. */
  pickDisplay(displayId: number): void
  save(): void
  cancel(): void
}

export interface UseZoneEditorInput {
  displayId: number
  demo?: boolean
  /** Route flag: several monitors start as a picker. */
  pick?: boolean
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

export function useZoneEditor({
  displayId,
  demo = false,
  pick = false
}: UseZoneEditorInput): ZoneEditorState {
  const { t } = useTranslation()
  const bridge = useMemo(() => window.vertragus?.zones, [])
  /**
   * Starts as the overlay's current size. Pinning the window to another
   * monitor fires `resize`; new zones and auto-layout must use that size.
   */
  const [viewport, setViewport] = useState<Viewport>(() => viewportNow())
  useEffect(() => {
    const onResize = (): void => setViewport(viewportNow())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
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
  /**
   * Multi-monitor picker vs rectangle editor. Starts from the route flag and
   * flips locally on pick — the overlay is not remounted.
   */
  const [selecting, setSelecting] = useState(Boolean(pick))
  /** Monotonic counter for local zone keys and the new-zone cascade. */
  const created = useRef(seed ? seed.zones.length : 0)
  const activeDisplayId = payload?.displayId ?? displayId

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    if (demo || !bridge) return undefined
    let alive = true
    bridge.load().then(
      (loaded) => {
        if (!alive) return
        // An overlay may not call `settings:get`, so this payload is the only
        // place its language and theme can come from at open (see appIpc's
        // zones:load handler). Later flips still arrive via `ev:settings`.
        void applyLocale(loaded.locale)
        applyTheme(loaded.theme)
        const view = viewportNow()
        setViewport(view)
        setPayload(loaded)
        setZones(toDrafts(loaded, view, created.current))
        created.current += loaded.zones.length
        // Stay in the picker only while both the route and this payload say so.
        // After a local pick, a late load must not flip the editor back.
        setSelecting((current) => current && loaded.selectingDisplay)
      },
      (cause) => {
        if (alive) setError(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, demo])

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
    bridge.draft(draftsToZones(zones, activeDisplayId, viewport))
  }, [bridge, demo, activeDisplayId, viewport, zones])

  const applyPayload = useCallback((loaded: ZoneEditorPayload): void => {
    const view = viewportNow()
    setViewport(view)
    setPayload(loaded)
    setZones(toDrafts(loaded, view, 0))
    created.current = loaded.zones.length
  }, [])

  const pickDisplay = useCallback(
    (nextDisplayId: number) => {
      setSelecting(false)
      if (!bridge || demo) return
      void bridge.pickDisplay(nextDisplayId).then(
        (loaded) => {
          void applyLocale(loaded.locale)
          applyTheme(loaded.theme)
          applyPayload(loaded)
          setSelecting(false)
        },
        (cause) => {
          setSelecting(true)
          setError(errorText(cause))
        }
      )
    },
    [applyPayload, bridge, demo]
  )

  return {
    ready: payload !== null,
    profileName: payload?.profileName ?? '',
    displayId: activeDisplayId,
    viewport,
    roles: payload?.roles ?? [],
    zones,
    error,
    saving,
    demo,
    selectingDisplay: selecting,
    displayLabel:
      (payload?.displays ?? []).find((entry) => entry.id === activeDisplayId)?.label ?? '',
    displayPrimary:
      (payload?.displays ?? []).find((entry) => entry.id === activeDisplayId)?.primary ?? false,
    displayCount: payload?.displays.length ?? 0,
    displays: payload?.displays ?? [],

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

    autoLayout() {
      if (!payload || payload.roles.length === 0) return
      const next: DraftZone[] = autoLayoutDrafts(payload.roles, viewport).map((draft) => {
        created.current += 1
        return { ...draft, id: `z${created.current}` }
      })
      setZones(next)
      // Push immediately — `commit()` would still see the previous `zones` closure.
      if (!bridge || demo) return
      bridge.draft(draftsToZones(next, activeDisplayId, viewport))
    },

    commit,

    pickDisplay,

    save() {
      if (demo) return
      if (!bridge || !payload) {
        setError(t('common.bridgeMissing'))
        return
      }
      setSaving(true)
      setError(null)
      bridge.save(payload.profileId, draftsToZones(zones, activeDisplayId, viewport)).then(
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
