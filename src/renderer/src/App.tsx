import { PanelApp } from './panel/PanelApp'
import { TerminalApp } from './terminal/TerminalApp'

/**
 * Route dispatch by window hash. Every Vertragus window loads the same bundle
 * and picks its surface from the route: /panel, /agent/<id>, /profile-editor,
 * /zones (M3/M4).
 */
export function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, '') || '/panel'
  if (route.startsWith('/agent/')) {
    return <TerminalApp agentId={decodeURIComponent(route.slice('/agent/'.length))} />
  }
  if (route.startsWith('/panel')) return <PanelApp />
  return <PanelApp />
}
