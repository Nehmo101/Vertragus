import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * Keep native edit accelerators available even though Vertragus hides the menu bar.
 * Without an application menu Electron does not reliably dispatch Ctrl/Cmd+C
 * in packaged frameless windows.
 */
export function installEditMenu(): void {
  const editItems: MenuItemConstructorOptions[] = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'delete' },
    { type: 'separator' },
    { role: 'selectAll' }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'Bearbeiten', submenu: editItems }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Show the standard edit actions for selected text and editable controls. */
export function installEditContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const canCopy = params.editFlags.canCopy || params.selectionText.length > 0
    const hasEditAction =
      canCopy || params.editFlags.canCut || params.editFlags.canPaste || params.isEditable

    if (!hasEditAction) return

    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    ])
    menu.popup({ window: win })
  })
}
