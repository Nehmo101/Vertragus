import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import { App } from './App'
import { followStoredLocale } from './i18n'

/**
 * Every window boots the same way: settle the UI language first, then render.
 *
 * The wait is bounded inside `followStoredLocale` — a window whose bridge does
 * not answer paints in the default language instead of not painting at all.
 */
async function boot(): Promise<void> {
  await followStoredLocale()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void boot()
