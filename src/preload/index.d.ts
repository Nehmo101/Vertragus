import type { VertragusApi } from './index'

export type {
  TerminalAgentMeta,
  TerminalAttachResult,
  TerminalDataEvent,
  TerminalExitEvent,
  VertragusApi
} from './index'

declare global {
  interface Window {
    vertragus: VertragusApi
  }
}

export {}
