import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import { App } from './App'
import { followAppearance } from './styles/appearance'
import { followStoredLocale } from './i18n'
import { followStoredTheme } from './theme'

/**
 * Every window boots the same way: settle language and appearance first, then
 * render.
 *
 * Every wait is bounded inside its own module and all run at once — a window
 * whose bridge does not answer paints in the default language, theme and the
 * design's glass, instead of not painting at all.
 */
async function boot(): Promise<void> {
  await Promise.all([followStoredLocale(), followStoredTheme(), followAppearance()])
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void boot()
