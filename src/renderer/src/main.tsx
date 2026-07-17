import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import '@xyflow/react/dist/style.css'
import './styles.css'

import './cozy-organic.css'
import './canvas.css'
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
