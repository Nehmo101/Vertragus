import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { resolveLaunch } from '@main/agents/resolveCommand'
import type { RemoteStatus, RemoteTunnelState } from '@shared/remote'

export interface TunnelConfig {
  origin: string
  hostname: string
  tunnelToken: string
  startupTimeoutMs?: number
}

export interface TunnelStatus {
  state: RemoteTunnelState
  publicUrl?: string
  error?: string
  reconnectAttempt: number
}

export interface TunnelProcess {
  kill(): boolean
  // Node child processes and lightweight tests both expose EventEmitter-style once().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): unknown
  stderr: NodeJS.ReadableStream | null
}

export type TunnelSpawner = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; env: NodeJS.ProcessEnv; stdio: ['ignore', 'ignore', 'pipe'] }
) => TunnelProcess

const URL_PATTERN = /https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d+)?(?:\/[^\s]*)?/ig

export function parseTunnelUrl(output: string): string | undefined {
  for (const match of output.matchAll(URL_PATTERN)) {
    try {
      const value = new URL(match[0])
      if (value.protocol !== 'https:' || !value.hostname.includes('.')) continue
      if (value.hostname === 'localhost' || value.hostname.endsWith('.localhost')) continue
      value.pathname = ''
      value.search = ''
      value.hash = ''
      return value.toString().replace(/\/$/, '')
    } catch {
      // Ignore unrelated malformed log fragments.
    }
  }
  return undefined
}

function normalizeHostname(hostname: string): string {
  const value = hostname.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) || !value.includes('.')) {
    throw new Error('Ungültiger Tunnel-Hostname.')
  }
  return value
}

export class TunnelManager extends EventEmitter {
  private child: TunnelProcess | undefined
  private stopping = false
  private restartTimer: NodeJS.Timeout | undefined
  private startupTimer: NodeJS.Timeout | undefined
  private config: TunnelConfig | undefined
  private current: TunnelStatus = { state: 'disabled', reconnectAttempt: 0 }

  constructor(
    private readonly spawnProcess: TunnelSpawner = spawn as unknown as TunnelSpawner,
    private readonly resolve: typeof resolveLaunch = resolveLaunch,
    private readonly random: () => number = Math.random
  ) { super() }

  status(): TunnelStatus { return { ...this.current } }

  private setStatus(next: TunnelStatus): void {
    this.current = next
    this.emit('status', this.status())
  }

  async start(config: TunnelConfig): Promise<void> {
    await this.stop()
    this.stopping = false
    this.config = { ...config, hostname: normalizeHostname(config.hostname) }
    this.setStatus({ state: 'starting', publicUrl: `https://${this.config.hostname}`, reconnectAttempt: 0 })
    await this.launch()
  }

  private async launch(): Promise<void> {
    const config = this.config
    if (!config || this.stopping) return
    const launch = await this.resolve('cloudflared', [
      'tunnel', '--no-autoupdate', '--url', config.origin, 'run'
    ])
    const child = this.spawnProcess(launch.file, launch.args, {
      windowsHide: true,
      env: { ...process.env, TUNNEL_TOKEN: config.tunnelToken },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    this.child = child
    let settled = false
    const online = (url = `https://${config.hostname}`): void => {
      if (settled || this.stopping) return
      settled = true
      if (this.startupTimer) clearTimeout(this.startupTimer)
      this.setStatus({ state: 'online', publicUrl: url, reconnectAttempt: this.current.reconnectAttempt })
    }
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const parsed = parseTunnelUrl(String(chunk))
      // Named tunnels may log several Cloudflare API URLs. Only accept the configured host;
      // quick-tunnel parsing is enabled explicitly in Phase B.
      if (parsed && new URL(parsed).hostname === config.hostname) online(parsed)
    })
    child.once('spawn', () => online())
    child.once('error', (error) => this.onExit(child, error instanceof Error ? error.message : String(error)))
    child.once('exit', (code, signal) => this.onExit(child, `cloudflared beendet (${code ?? signal ?? 'unbekannt'}).`))
    this.startupTimer = setTimeout(() => {
      if (this.child === child && !settled) {
        child.kill()
        this.onExit(child, 'Cloudflare Tunnel hat das Startup-Zeitlimit überschritten.')
      }
    }, config.startupTimeoutMs ?? 20_000)
    this.startupTimer.unref()
  }

  private onExit(child: TunnelProcess, message: string): void {
    if (this.child !== child) return
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.child = undefined
    if (this.stopping || !this.config) return
    const attempt = this.current.reconnectAttempt + 1
    this.setStatus({
      state: 'degraded',
      publicUrl: `https://${this.config.hostname}`,
      error: message,
      reconnectAttempt: attempt
    })
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5))
    const delay = Math.round(base * (0.8 + this.random() * 0.4))
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => { void this.launch() }, delay)
    this.restartTimer.unref()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.config = undefined
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.restartTimer = undefined
    this.startupTimer = undefined
    const child = this.child
    this.child = undefined
    child?.kill()
    this.setStatus({ state: 'disabled', reconnectAttempt: 0 })
  }
}

export function tunnelStatusToRemote(status: TunnelStatus): Pick<RemoteStatus, 'tunnel' | 'publicUrl' | 'error'> {
  return { tunnel: status.state, publicUrl: status.publicUrl, error: status.error }
}

export const tunnelManagerInternals = { normalizeHostname }
