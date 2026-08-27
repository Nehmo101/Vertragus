/**
 * The demo layout the screenshot hook draws (`?demo=1`, set only by
 * `VERTRAGUS_ZONES_SCREENSHOT` in main/windows/zoneOverlay.ts).
 *
 * It exists so the overlay can be verified visually on a fresh install without
 * writing a throwaway profile into the user's real store — the alternative was
 * a smoke run that permanently leaves a "Zonen-Demo" profile behind.
 */
import { ORCHESTRATOR_COLOR, roleColor } from '@shared/prompts/roles'
import type { ZoneEditorPayload } from '../../../preload'

export function demoZoneEditorPayload(displayId: number): ZoneEditorPayload {
  return {
    profileId: 'demo',
    profileName: 'Vertragus',
    displayId,
    roles: [
      { roleId: 'orchestrator', label: 'Orchestrator', color: ORCHESTRATOR_COLOR },
      { roleId: 'worker', label: 'Worker', color: roleColor('worker') },
      { roleId: 'reviewer', label: 'Reviewer', color: roleColor('reviewer') },
      { roleId: 'tester', label: 'Tester', color: roleColor('tester') }
    ],
    zones: [
      { roleId: 'orchestrator', displayId, rect: { x: 0.04, y: 0.08, w: 0.36, h: 0.54 } },
      { roleId: 'worker', displayId, rect: { x: 0.44, y: 0.08, w: 0.52, h: 0.34 } },
      { roleId: 'reviewer', displayId, rect: { x: 0.44, y: 0.46, w: 0.52, h: 0.34 } }
    ],
    displays: [{ id: displayId, label: 'Demo', width: 1920, height: 1080, x: 0, y: 0, primary: true }],
    selectingDisplay: false
  }
}
