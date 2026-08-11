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
  WorkspaceAgentSummary,
  WorkspaceSummary
} from './index'

declare global {
  interface Window {
    vertragus: VertragusApi
  }
}

export {}
