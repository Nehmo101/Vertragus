import { contextBridge, ipcRenderer } from 'electron'

/**
 * The renderer bridge. One API object per window type; a CLI window only ever
 * gets the terminal surface, and that surface carries no agentId for input,
 * resize or close — the main process derives the agent from the sender window,
 * so a renderer cannot address a foreign agent even if it tries.
 *
 * Channel names are duplicated from src/main/ipc.ts on purpose: preload is
 * bundled separately and must not import main code. ipc.test.ts asserts both
 * lists stay identical.
 */
const CHANNELS = {
  attach: 'terminal:attach',
  input: 'terminal:input',
  resize: 'terminal:resize',
  data: 'terminal:data',
  exit: 'terminal:exit',
  windowClose: 'window:close'
} as const

export interface TerminalAgentMeta {
  agentId: string
  name: string
  role: string
  roleColor: string
  provider: string
  model: string
}

export interface TerminalAttachResult {
  snapshot: string
  cols: number
  rows: number
  meta: TerminalAgentMeta
  exit: { exitCode: number; signal?: number } | null
}

export interface TerminalDataEvent {
  agentId: string
  data: string
}

export interface TerminalExitEvent {
  agentId: string
  exitCode: number
  signal?: number
}

const terminal = {
  /** Replay the scrollback and learn who this window belongs to. */
  attach: (agentId: string): Promise<TerminalAttachResult> =>
    ipcRenderer.invoke(CHANNELS.attach, { agentId }),
  input: (data: string): void => {
    ipcRenderer.send(CHANNELS.input, data)
  },
  resize: (cols: number, rows: number): void => {
    ipcRenderer.send(CHANNELS.resize, { cols, rows })
  },
  onData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: TerminalDataEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.data, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.data, handler)
    }
  },
  onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: TerminalExitEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.exit, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.exit, handler)
    }
  },
  /** Close this window only — the agent keeps running. */
  closeWindow: (): void => {
    ipcRenderer.send(CHANNELS.windowClose)
  }
}

const api = {
  platform: process.platform,
  terminal
}

export type VertragusApi = typeof api

contextBridge.exposeInMainWorld('vertragus', api)
