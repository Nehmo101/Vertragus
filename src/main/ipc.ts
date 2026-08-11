/**
 * Terminal IPC — the bridge between an agent's PTY and its CLI window.
 *
 * Authorization is structural, not a check bolted on: every channel resolves
 * the *sender* to an agentId through the CLI window registry. A renderer never
 * chooses which agent it talks to, so a compromised or buggy window cannot read
 * or type into another agent's terminal. The panel (or any other window) is not
 * a CLI window and is therefore rejected outright.
 *
 * Output is coalesced per agent (~one frame) before it crosses the IPC bridge:
 * a chatty CLI emits dozens of tiny chunks per second and each one would
 * otherwise be its own structured-clone + renderer wakeup.
 *
 * Data is only pushed while a window is attached. Everything else lives in the
 * PtyAgent scrollback and is replayed by `terminal:attach`, which makes late
 * attach (window opens after the agent started) and re-attach lossless and
 * duplicate-free without sequence numbers: attach is the sync point.
 */
import { ipcMain } from 'electron'
import type { PtyAgentLike, PtyExitInfo } from './agents/PtyAgent'
import { getSettings } from './store/settings'
import { closeCliWindow, getCliWindow, isCliWindowSender } from './windows/cliWindow'

export const TERMINAL_CHANNELS = {
  attach: 'terminal:attach',
  input: 'terminal:input',
  resize: 'terminal:resize',
  data: 'terminal:data',
  exit: 'terminal:exit',
  windowClose: 'window:close'
} as const

/** ~one frame: long enough to merge a burst, short enough to feel live. */
export const TERMINAL_COALESCE_MS = 16

export interface AgentMeta {
  agentId: string
  name: string
  role: string
  roleColor: string
  provider: string
  model: string
}

export interface RegisteredAgent {
  pty: PtyAgentLike
  meta: AgentMeta
}

export interface TerminalAttachResult {
  snapshot: string
  cols: number
  rows: number
  meta: AgentMeta
  /** Set when the process already died before the window attached. */
  exit: PtyExitInfo | null
  /**
   * UI language at attach time. CLI windows may not call settings:get (window
   * type guard) and are not a settings broadcast target, so the locale rides
   * along with the attach result instead.
   */
  locale?: string
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

/**
 * The slim surface M2 (MCP tools) consumes. `start_agent` registers, `list_agents`
 * lists, `stop_agent` removes — none of them need to know about windows or IPC.
 */
export interface AgentRegistry {
  registerAgent(entry: RegisteredAgent): void
  getAgent(agentId: string): RegisteredAgent | undefined
  removeAgent(agentId: string): void
  listAgents(): RegisteredAgent[]
  /** Window gone — stop pushing until it attaches again. */
  markDetached(agentId: string): void
  dispose(): void
}

type IpcListener = (event: { sender: { id: number } }, ...args: never[]) => unknown

export interface MinimalIpcMain {
  handle(channel: string, listener: IpcListener): void
  on(channel: string, listener: IpcListener): void
  removeHandler(channel: string): void
  removeAllListeners(channel: string): void
}

export interface TerminalIpcHost {
  ipcMain: MinimalIpcMain
  /** agentId of the CLI window behind this webContents, or null. */
  senderAgentId(webContentsId: number): string | null
  send(agentId: string, channel: string, payload: unknown): void
  /** False once the window is gone — the stream then stops by itself. */
  hasWindow?(agentId: string): boolean
  closeWindow(agentId: string): void
  coalesceMs?: number
  /** UI language for attach results; CLI windows cannot query settings. */
  locale?(): string
}

interface AgentRecord {
  entry: RegisteredAgent
  attached: boolean
  pending: string
  timer: ReturnType<typeof setTimeout> | undefined
  exit: PtyExitInfo | null
  unsubscribe: (() => void)[]
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function createTerminalIpc(host: TerminalIpcHost): AgentRegistry {
  const coalesceMs = host.coalesceMs ?? TERMINAL_COALESCE_MS
  const agents = new Map<string, AgentRecord>()

  const flush = (record: AgentRecord): void => {
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = undefined
    }
    if (!record.pending) return
    const data = record.pending
    record.pending = ''
    if (!record.attached) return
    const agentId = record.entry.meta.agentId
    // A window can vanish without a close message (crash, kill); stop streaming
    // and wait for the next attach instead of talking to a dead renderer.
    if (host.hasWindow && !host.hasWindow(agentId)) {
      record.attached = false
      return
    }
    const payload: TerminalDataEvent = { agentId, data }
    host.send(agentId, TERMINAL_CHANNELS.data, payload)
  }

  const onChunk = (record: AgentRecord, data: string): void => {
    // Detached windows are served from the scrollback on attach.
    if (!record.attached || !data) return
    record.pending += data
    if (record.timer) return
    record.timer = setTimeout(() => flush(record), coalesceMs)
    record.timer.unref?.()
  }

  const resolveRecord = (event: { sender: { id: number } }): AgentRecord | null => {
    const agentId = host.senderAgentId(event.sender.id)
    if (!agentId) return null
    return agents.get(agentId) ?? null
  }

  host.ipcMain.handle(TERMINAL_CHANNELS.attach, ((
    event: { sender: { id: number } },
    payload?: { agentId?: string }
  ): TerminalAttachResult => {
    const agentId = host.senderAgentId(event.sender.id)
    if (!agentId) throw new Error('terminal:attach rejected — sender is not a CLI window')
    if (payload?.agentId && payload.agentId !== agentId) {
      throw new Error('terminal:attach rejected — window may only attach to its own agent')
    }
    const record = agents.get(agentId)
    if (!record) throw new Error(`terminal:attach rejected — unknown agent ${agentId}`)

    // Sync point: drop anything queued (it is in the snapshot) and only then
    // open the stream, so the renderer can never see a chunk twice.
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = undefined
    }
    record.pending = ''
    record.attached = true
    return {
      snapshot: record.entry.pty.snapshot(),
      cols: record.entry.pty.cols,
      rows: record.entry.pty.rows,
      meta: record.entry.meta,
      exit: record.exit,
      ...(host.locale ? { locale: host.locale() } : {})
    }
  }) as IpcListener)

  host.ipcMain.on(TERMINAL_CHANNELS.input, ((
    event: { sender: { id: number } },
    data?: unknown
  ): void => {
    const record = resolveRecord(event)
    if (!record || typeof data !== 'string' || !data) return
    record.entry.pty.write(data)
  }) as IpcListener)

  host.ipcMain.on(TERMINAL_CHANNELS.resize, ((
    event: { sender: { id: number } },
    payload?: { cols?: unknown; rows?: unknown }
  ): void => {
    const record = resolveRecord(event)
    if (!record) return
    const cols = payload?.cols
    const rows = payload?.rows
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return
    record.entry.pty.resize(Math.floor(cols), Math.floor(rows))
  }) as IpcListener)

  host.ipcMain.on(TERMINAL_CHANNELS.windowClose, ((event: { sender: { id: number } }): void => {
    const agentId = host.senderAgentId(event.sender.id)
    if (!agentId) return
    // Only the window goes away — the agent keeps working.
    const record = agents.get(agentId)
    if (record) {
      record.attached = false
      record.pending = ''
      if (record.timer) {
        clearTimeout(record.timer)
        record.timer = undefined
      }
    }
    host.closeWindow(agentId)
  }) as IpcListener)

  const detach = (record: AgentRecord): void => {
    for (const off of record.unsubscribe) off()
    record.unsubscribe = []
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = undefined
    }
  }

  return {
    registerAgent(entry: RegisteredAgent): void {
      const agentId = entry.meta.agentId
      const previous = agents.get(agentId)
      if (previous) detach(previous)

      const record: AgentRecord = {
        entry,
        attached: false,
        pending: '',
        timer: undefined,
        exit: null,
        unsubscribe: []
      }
      agents.set(agentId, record)
      record.unsubscribe.push(entry.pty.onData((data) => onChunk(record, data)))
      record.unsubscribe.push(
        entry.pty.onExit((info) => {
          record.exit = info
          flush(record)
          if (!record.attached) return
          const payload: TerminalExitEvent = {
            agentId,
            exitCode: info.exitCode,
            signal: info.signal
          }
          host.send(agentId, TERMINAL_CHANNELS.exit, payload)
        })
      )
    },
    getAgent(agentId: string): RegisteredAgent | undefined {
      return agents.get(agentId)?.entry
    },
    removeAgent(agentId: string): void {
      const record = agents.get(agentId)
      if (!record) return
      detach(record)
      agents.delete(agentId)
    },
    listAgents(): RegisteredAgent[] {
      return [...agents.values()].map((record) => record.entry)
    },
    markDetached(agentId: string): void {
      const record = agents.get(agentId)
      if (!record) return
      record.attached = false
      record.pending = ''
      if (record.timer) {
        clearTimeout(record.timer)
        record.timer = undefined
      }
    },
    dispose(): void {
      for (const record of agents.values()) detach(record)
      agents.clear()
      for (const channel of Object.values(TERMINAL_CHANNELS)) {
        host.ipcMain.removeAllListeners(channel)
      }
      host.ipcMain.removeHandler(TERMINAL_CHANNELS.attach)
    }
  }
}

let registry: AgentRegistry | undefined

/** Production wiring: real ipcMain, real CLI window registry. */
export function registerTerminalIpc(): AgentRegistry {
  if (registry) return registry
  registry = createTerminalIpc({
    ipcMain: ipcMain as unknown as MinimalIpcMain,
    senderAgentId: (webContentsId) => isCliWindowSender(webContentsId),
    hasWindow: (agentId) => getCliWindow(agentId) !== null,
    send: (agentId, channel, payload) => {
      const win = getCliWindow(agentId)
      if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
    },
    closeWindow: (agentId) => closeCliWindow(agentId),
    locale: () => getSettings().ui.locale
  })
  return registry
}

/** The registry M2 wires its MCP tools into. */
export function getAgentRegistry(): AgentRegistry {
  return registerTerminalIpc()
}
