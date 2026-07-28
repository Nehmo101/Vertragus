/**
 * Pure Menü-Item-Liste des TitleBar-Überlaufmenüs („⋯“). Ausgelagert, damit die
 * Sichtbarkeits-/Checked-Logik ohne DOM testbar bleibt; TitleBar.tsx mappt die
 * Item-Ids auf die Store-Aktionen.
 */

export type OverflowItemId =
  | 'language'
  | 'theme'
  | 'readable'
  | 'density'
  | 'update'
  | 'updateChannel'

export interface OverflowMenuItem {
  id: OverflowItemId
  /** ARIA-Rolle: Umschalter sind menuitemcheckbox, Aktionen menuitem. */
  role: 'menuitemcheckbox' | 'menuitem'
  label: string
  /** Rechtsbündiger Zusatztext (z. B. aktuelle Sprache). */
  detail?: string
  /** Nur bei role=menuitemcheckbox gesetzt. */
  checked?: boolean
  disabled?: boolean
}

export interface OverflowMenuContext {
  language: 'de' | 'en'
  theme: 'light' | 'dark'
  cliReadable: boolean
  uiDensity: 'comfortable' | 'compact'
  /** true, sobald ein Update verfügbar/ladend/geladen/fehlgeschlagen ist. */
  updateVisible: boolean
  updateLabel: string
  updateDisabled: boolean
  /** null = Kanal unbekannt oder Updates nicht unterstützt. */
  updateChannel: 'stable' | 'main' | null
}

export function buildOverflowMenuItems(ctx: OverflowMenuContext): OverflowMenuItem[] {
  const items: OverflowMenuItem[] = [
    {
      id: 'language',
      role: 'menuitem',
      label: 'Sprache wechseln',
      detail: ctx.language === 'de' ? 'Deutsch' : 'English'
    },
    {
      id: 'theme',
      role: 'menuitemcheckbox',
      label: 'Dunkles Design',
      checked: ctx.theme === 'dark'
    },
    {
      id: 'readable',
      role: 'menuitemcheckbox',
      label: 'Lesbare CLI-Ausgabe',
      checked: ctx.cliReadable
    },
    {
      id: 'density',
      role: 'menuitemcheckbox',
      label: 'Kompakte Ansicht',
      checked: ctx.uiDensity === 'compact'
    }
  ]
  if (ctx.updateVisible) {
    items.push({
      id: 'update',
      role: 'menuitem',
      label: ctx.updateLabel,
      disabled: ctx.updateDisabled
    })
  }
  if (ctx.updateChannel) {
    items.push({
      id: 'updateChannel',
      role: 'menuitem',
      label: 'Update-Kanal wechseln',
      detail: ctx.updateChannel === 'stable' ? 'Stable' : 'Main'
    })
  }
  return items
}
