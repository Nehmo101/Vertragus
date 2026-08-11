/**
 * Every visible string of the zone overlay. Same rule as the panel and the
 * profile editor: one object per surface, so M6 lifts it into i18n unchanged.
 */
export const ZONE_STRINGS = {
  title: (profile: string): string => `Zonen für „${profile}"`,
  hint: 'Rechteck ziehen zum Verschieben · Ecke unten rechts skaliert · Esc bricht ab',
  display: (width: number, height: number): string => `Bildschirm ${width} × ${height}`,
  palette: 'Zone hinzufügen',
  addZone: (role: string): string => `+ ${role}`,
  removeZone: (role: string): string => `Zone „${role}" entfernen`,
  empty: 'Noch keine Zone auf diesem Bildschirm — wähle unten eine Rolle.',
  save: 'Speichern',
  saving: 'Speichert …',
  cancel: 'Abbrechen (Esc)',
  loading: 'Lädt …',
  bridgeMissing: 'Preload-Bridge nicht verfügbar.',
  demoBadge: 'Demo-Ansicht'
} as const
