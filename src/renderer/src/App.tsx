import { PanelApp } from './panel/PanelApp'
import { ProfileEditorApp } from './profileEditor/ProfileEditorApp'
import { TerminalApp } from './terminal/TerminalApp'
import { ZonesApp } from './zones/ZonesApp'

const PROFILE_EDITOR_ROUTE = '/profile-editor'
const ZONES_ROUTE = '/zones/'

/**
 * Route dispatch by window hash. Every Vertragus window loads the same bundle
 * and picks its surface from the route: /panel, /agent/<id>,
 * /profile-editor[/<id>], /zones/<displayId>?profile=<id>.
 */
export function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, '') || '/panel'
  if (route.startsWith('/agent/')) {
    return <TerminalApp agentId={decodeURIComponent(route.slice('/agent/'.length))} />
  }
  if (route.startsWith(ZONES_ROUTE)) {
    // The profile itself comes from main (the overlay's window identity), so
    // only the display and the demo flag are read from the route here.
    const [path, query] = route.slice(ZONES_ROUTE.length).split('?')
    const params = new URLSearchParams(query ?? '')
    return <ZonesApp displayId={Number(path) || 0} demo={params.get('demo') === '1'} />
  }
  if (route.startsWith(PROFILE_EDITOR_ROUTE)) {
    // No id = a profile that does not exist yet.
    const rest = route.slice(PROFILE_EDITOR_ROUTE.length).replace(/^\//, '')
    return <ProfileEditorApp profileId={rest ? decodeURIComponent(rest) : undefined} />
  }
  if (route.startsWith('/panel')) return <PanelApp />
  return <PanelApp />
}
