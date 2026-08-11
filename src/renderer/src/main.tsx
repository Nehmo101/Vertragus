import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import { App } from './App'
import { followStoredLocale } from './i18n'
import { followStoredTheme } from './theme'

/**
 * Every window boots the same way: settle language and appearance first, then
 * render. Both waits are bounded — a window whose bridge does not answer paints
 * in the defaults instead of not painting at all.
 */
async function boot(): Promise<void> {
  await Promise.all([followStoredLocale(), followStoredTheme()])
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void boot()
