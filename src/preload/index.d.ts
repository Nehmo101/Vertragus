import type { VertragusApi } from './index'

export type {
  ModelDiscoveryResult,
  PanelAgentState,
  PanelSettings,
  ProviderHealth,
  ProviderListEntry,
  TerminalAgentMeta,
  TerminalAttachResult,
  TerminalDataEvent,
  TerminalExitEvent,
  VertragusApi,
  VertragusAppApi,
  VertragusZonesApi,
  WorkspaceAgentSummary,
  WorkspaceSummary,
  ZoneEditorPayload,
  ZoneEditorRole
} from './index'

declare global {
  interface Window {
    vertragus: VertragusApi
  }
}

export {}
