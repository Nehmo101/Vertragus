import React from 'react'
import ReactDOM from 'react-dom/client'
import { initLanguageFromConfig } from './i18n'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import '@xyflow/react/dist/style.css'
import './styles.css'

import './cozy-organic.css'
import './canvas.css'

void initLanguageFromConfig()
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
