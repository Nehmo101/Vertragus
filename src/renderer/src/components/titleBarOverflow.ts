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
  | 'startMode'
  | 'showRail'
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
  /** Startmodus des nächsten App-Starts: Vollfenster oder Desktop-Rail. */
  startMode: 'full' | 'rail'
}

/** Minimale Übersetzer-Signatur, damit i18next-`t` direkt durchgereicht werden kann. */
export type OverflowTranslate = (key: string) => string

export function buildOverflowMenuItems(
  ctx: OverflowMenuContext,
  t: OverflowTranslate
): OverflowMenuItem[] {
  const items: OverflowMenuItem[] = [
    {
      id: 'language',
      role: 'menuitem',
      label: t('titlebar.overflow.language'),
      detail:
        ctx.language === 'de'
          ? t('titlebar.overflow.languageGerman')
          : t('titlebar.overflow.languageEnglish')
    },
    {
      id: 'theme',
      role: 'menuitemcheckbox',
      label: t('titlebar.overflow.darkTheme'),
      checked: ctx.theme === 'dark'
    },
    {
      id: 'readable',
      role: 'menuitemcheckbox',
      label: t('titlebar.overflow.readable'),
      checked: ctx.cliReadable
    },
    {
      id: 'density',
      role: 'menuitemcheckbox',
      label: t('titlebar.overflow.density'),
      checked: ctx.uiDensity === 'compact'
    },
    {
      id: 'startMode',
      role: 'menuitem',
      label: t('titlebar.overflow.startMode'),
      detail:
        ctx.startMode === 'rail'
          ? t('titlebar.overflow.startModeRail')
          : t('titlebar.overflow.startModeFull')
    },
    {
      id: 'showRail',
      role: 'menuitem',
      label: t('titlebar.overflow.showRail')
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
      label: t('titlebar.overflow.updateChannel'),
      detail: ctx.updateChannel === 'stable' ? 'Stable' : 'Main'
    })
  }
  return items
}
