import type { VertragusApi } from './index'

export type {
  CliTabInfo,
  CliTabState,
  ModelDiscoveryResult,
  PanelAgentState,
  PanelPointerEvent,
  PanelMcpServer,
  PanelSettings,
  ProviderHealth,
  ProviderListEntry,
  TerminalAgentMeta,
  TerminalAttachResult,
  TerminalDataEvent,
  TerminalExitEvent,
  VoiceEventPayload,
  VoicePhase,
  VoiceStatusPayload,
  VertragusApi,
  VertragusAppApi,
  VertragusZonesApi,
  WorkspaceAgentSummary,
  WorkspaceSummary,
  ZoneDisplayInfo,
  ZoneEditorPayload,
  ZoneEditorRole
} from './index'

declare global {
  interface Window {
    vertragus: VertragusApi
  }
}

export {}
