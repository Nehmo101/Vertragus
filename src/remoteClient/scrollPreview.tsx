/**
 * Local harness for the remote terminal's scroll path. Not an input of
 * `vite.remoteClient.config.ts`, so it never ships in `out/remote`. Open
 * `/scrollPreview.html` against `vite --config vite.remoteClient.config.ts`.
 */
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { remoteCopy } from './i18n'
import { RemoteTerminal } from './RemoteTerminal'
import type { RemoteApi } from './useRemote'
import './styles.css'

const SNAPSHOT_LINES = 220

function fakeSnapshot(): string {
  const rows: string[] = []
  for (let index = 0; index < SNAPSHOT_LINES; index += 1) {
    const marker = index % 20 === 0 ? `  <<< ${index} >>>` : ''
    rows.push(
      `\x1b[90m${String(index).padStart(4, '0')}\x1b[0m  agent output ${'█'.repeat((index % 12) + 1)}${marker}\r\n`
    )
  }
  rows.push('\x1b[32mready.\x1b[0m waiting for input.\r\n')
  return rows.join('')
}

function mockApi(): RemoteApi {
  return {
    phase: 'ready',
    error: null,
    workspaces: [],
    theme: 'dark',
    locale: 'en',
    online: true,
    probing: false,
    attach(_agentId, handlers) {
      const snapshot = fakeSnapshot()
      queueMicrotask(() => {
        handlers.onSnapshot(snapshot, 80, 24, 'Virgilio', '#cba35a', null)
      })
      return () => undefined
    },
    sendInput() {
      /* preview */
    },
    resize() {
      /* preview — never round-trip a size to a host that is not there */
    },
    runCommand() {
      return Promise.resolve(null)
    },
    refresh() {
      /* preview */
    },
    retrying: false,
    retryPairing() {
      /* preview */
    },
    reset() {
      /* preview */
    }
  }
}

function Preview(): React.JSX.Element {
  const api = useMemo(() => mockApi(), [])
  const copy = useMemo(() => remoteCopy('en'), [])
  return <RemoteTerminal agentId="preview" api={api} copy={copy} onBack={() => undefined} />
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Preview />
    </StrictMode>
  )
}
