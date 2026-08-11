import { PanelApp } from './panel/PanelApp'
import { ProfileEditorApp } from './profileEditor/ProfileEditorApp'
import { ProviderEditorApp } from './providerEditor/ProviderEditorApp'
import { SettingsApp } from './settings/SettingsApp'
import { TerminalApp } from './terminal/TerminalApp'
import { ZonesApp } from './zones/ZonesApp'

const PROFILE_EDITOR_ROUTE = '/profile-editor'
const PROVIDER_EDITOR_ROUTE = '/provider-editor'
const ZONES_ROUTE = '/zones/'

/**
 * Route dispatch by window hash. Every Vertragus window loads the same bundle
 * and picks its surface from the route: /panel, /agent/<id>,
 * /profile-editor[/<id>], /provider-editor[/<id>], /settings,
 * /zones/<displayId>?profile=<id>.
 */
export function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, '') || '/panel'
  if (route.startsWith('/agent/')) {
    return <TerminalApp agentId={decodeURIComponent(route.slice('/agent/'.length))} />
  }
  if (route.startsWith('/settings')) return <SettingsApp />
  if (route.startsWith(ZONES_ROUTE)) {
    // The profile itself comes from main (the overlay's window identity), so
    // only the display and the demo flag are read from the route here.
    const [path, query] = route.slice(ZONES_ROUTE.length).split('?')
    const params = new URLSearchParams(query ?? '')
    return <ZonesApp displayId={Number(path) || 0} demo={params.get('demo') === '1'} />
  }
  // Before the profile route: '/profile-editor' is not a prefix of
  // '/provider-editor', but keeping the more specific test first is what stops
  // a future rename from silently routing one editor into the other.
  if (route.startsWith(PROVIDER_EDITOR_ROUTE)) {
    // No id = a provider that does not exist yet.
    const rest = route.slice(PROVIDER_EDITOR_ROUTE.length).replace(/^\//, '')
    return <ProviderEditorApp providerId={rest ? decodeURIComponent(rest) : undefined} />
  }
  if (route.startsWith(PROFILE_EDITOR_ROUTE)) {
    // No id = a profile that does not exist yet.
    const rest = route.slice(PROFILE_EDITOR_ROUTE.length).replace(/^\//, '')
    return <ProfileEditorApp profileId={rest ? decodeURIComponent(rest) : undefined} />
  }
  if (route.startsWith('/panel')) return <PanelApp />
  return <PanelApp />
}
