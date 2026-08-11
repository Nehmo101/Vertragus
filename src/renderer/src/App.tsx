import { PanelApp } from './panel/PanelApp'
import { ProfileEditorApp } from './profileEditor/ProfileEditorApp'
import { TerminalApp } from './terminal/TerminalApp'

const PROFILE_EDITOR_ROUTE = '/profile-editor'

/**
 * Route dispatch by window hash. Every Vertragus window loads the same bundle
 * and picks its surface from the route: /panel, /agent/<id>,
 * /profile-editor[/<id>], /zones (M4).
 */
export function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, '') || '/panel'
  if (route.startsWith('/agent/')) {
    return <TerminalApp agentId={decodeURIComponent(route.slice('/agent/'.length))} />
  }
  if (route.startsWith(PROFILE_EDITOR_ROUTE)) {
    // No id = a profile that does not exist yet.
    const rest = route.slice(PROFILE_EDITOR_ROUTE.length).replace(/^\//, '')
    return <ProfileEditorApp profileId={rest ? decodeURIComponent(rest) : undefined} />
  }
  if (route.startsWith('/panel')) return <PanelApp />
  return <PanelApp />
}
