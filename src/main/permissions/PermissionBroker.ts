import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { AgentProviderId } from '@shared/providers'
import type { PermissionRequest } from '@shared/remote'

export type PermissionDecision = 'allow' | 'deny'
export type PermissionCoverage = 'native-callback' | 'sandbox-prompt' | 'coarse-pty' | 'unsupported'

export interface ProviderPermissionAdapter {
  provider: AgentProviderId
  coverage: PermissionCoverage
  /** Matches only a provider-owned confirmation surface, never arbitrary model prose. */
  parsePrompt(tail: string): { tool: string } | undefined
  response(decision: PermissionDecision): string
}

export interface PermissionContext {
  provider: AgentProviderId
  agentId: string
  taskId?: string
  profileId?: string
  workspaceSessionId?: string
  engineId?: string
  yolo: boolean
}

interface PendingEntry {
  request: PermissionRequest
  respond: (response: string) => void
  adapter: ProviderPermissionAdapter
  timer: ReturnType<typeof setTimeout>
  fingerprint: string
}

const cleanTool = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80) || 'provider-tool'

const claudeAdapter: ProviderPermissionAdapter = {
  provider: 'claude',
  coverage: 'native-callback',
  parsePrompt: (tail) => {
    const match = /Claude Code permission\s*:\s*Allow tool\s+([a-zA-Z0-9_.:-]+)\?\s*\[y\/n\]\s*$/i.exec(tail)
    return match ? { tool: cleanTool(match[1]!) } : undefined
  },
  response: (decision) => decision === 'allow' ? 'y\r' : 'n\r'
}

const kimiAdapter: ProviderPermissionAdapter = {
  provider: 'kimi',
  // Kimi Code CLI resolves tool permissions through the same MCP callback path
  // as Claude; this PTY matcher is the interactive fallback.
  coverage: 'native-callback',
  parsePrompt: (tail) => {
    const match = /Kimi(?: Code)? permission\s*:\s*Allow tool\s+([a-zA-Z0-9_.:-]+)\?\s*\[y\/n\]\s*$/i.exec(tail)
    return match ? { tool: cleanTool(match[1]!) } : undefined
  },
  response: (decision) => decision === 'allow' ? 'y\r' : 'n\r'
}

const codexAdapter: ProviderPermissionAdapter = {
  provider: 'codex',
  coverage: 'sandbox-prompt',
  parsePrompt: (tail) => {
    const match = /Codex sandbox approval\s*:\s*Allow tool\s+([a-zA-Z0-9_.:-]+)\?\s*\[y\/n\]\s*$/i.exec(tail)
    return match ? { tool: cleanTool(match[1]!) } : undefined
  },
  response: (decision) => decision === 'allow' ? 'y\r' : 'n\r'
}

function coarseAdapter(provider: 'cursor' | 'copilot'): ProviderPermissionAdapter {
  return {
    provider,
    coverage: 'coarse-pty',
    parsePrompt: (tail) => {
      const label = provider === 'cursor' ? 'Cursor Agent' : 'GitHub Copilot'
      const pattern = new RegExp(`${label} permission\\s*:\\s*Allow tool\\s+([a-zA-Z0-9_.:-]+)\\?\\s*\\[y\\/n\\]\\s*$`, 'i')
      const match = pattern.exec(tail)
      return match ? { tool: cleanTool(match[1]!) } : undefined
    },
    response: (decision) => decision === 'allow' ? 'y\r' : 'n\r'
  }
}

const ollamaAdapter: ProviderPermissionAdapter = {
  provider: 'ollama',
  coverage: 'unsupported',
  parsePrompt: () => undefined,
  response: () => ''
}

const ADAPTERS: Record<AgentProviderId, ProviderPermissionAdapter> = {
  claude: claudeAdapter,
  kimi: kimiAdapter,
  codex: codexAdapter,
  cursor: coarseAdapter('cursor'),
  copilot: coarseAdapter('copilot'),
  ollama: ollamaAdapter
}

export class PermissionBroker extends EventEmitter {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly fingerprints = new Map<string, string>()

  constructor(
    private readonly timeoutMs = 60_000,
    private readonly now: () => number = Date.now
  ) {
    super()
  }

  adapter(provider: AgentProviderId): ProviderPermissionAdapter {
    return ADAPTERS[provider]
  }

  inspectOutput(
    context: PermissionContext,
    outputTail: string,
    respondInternally: (response: string) => void
  ): PermissionRequest | undefined {
    if (context.yolo) return undefined
    const adapter = this.adapter(context.provider)
    if (adapter.coverage === 'unsupported') return undefined
    const parsed = adapter.parsePrompt(outputTail.slice(-2_000))
    if (!parsed) return undefined
    const fingerprint = `${context.agentId}:${parsed.tool}:${outputTail.slice(-160)}`
    if (this.fingerprints.get(context.agentId) === fingerprint) return undefined
    this.fingerprints.set(context.agentId, fingerprint)
    return this.open(context, parsed.tool, adapter, respondInternally, fingerprint)
  }

  /** Entry point for Claude PreToolUse/MCP permission callbacks when available. */
  requestFromProviderCallback(
    context: PermissionContext,
    tool: string,
    respondInternally: (response: string) => void
  ): PermissionRequest | undefined {
    if (context.yolo) return undefined
    const adapter = this.adapter(context.provider)
    if (adapter.coverage === 'unsupported') {
      respondInternally(adapter.response('deny'))
      return undefined
    }
    const safeTool = cleanTool(tool)
    return this.open(context, safeTool, adapter, respondInternally, `${context.agentId}:${safeTool}:${randomUUID()}`)
  }

  requestDecision(context: PermissionContext, tool: string): Promise<PermissionDecision> {
    if (context.yolo || this.adapter(context.provider).coverage === 'unsupported') {
      return Promise.resolve('deny')
    }
    const adapter = this.adapter(context.provider)
    const safeTool = cleanTool(tool)
    return new Promise<PermissionDecision>((resolve) => {
      this.open(context, safeTool, adapter, (response) => {
        resolve(response === adapter.response('allow') ? 'allow' : 'deny')
      }, `${context.agentId}:${safeTool}:${randomUUID()}`)
    })
  }

  private open(
    context: PermissionContext,
    tool: string,
    adapter: ProviderPermissionAdapter,
    respond: (response: string) => void,
    fingerprint: string
  ): PermissionRequest {
    const createdAt = this.now()
    const request: PermissionRequest = {
      id: randomUUID(),
      provider: context.provider,
      agentId: context.agentId,
      taskId: context.taskId,
      profileId: context.profileId,
      workspaceSessionId: context.workspaceSessionId,
      engineId: context.engineId,
      tool,
      summary: `${context.provider} bittet um Freigabe für ${tool}.`,
      createdAt,
      expiresAt: createdAt + this.timeoutMs
    }
    const timer = setTimeout(() => this.resolve(request.id, 'deny', 'timeout'), this.timeoutMs)
    timer.unref?.()
    this.pending.set(request.id, { request, respond, adapter, timer, fingerprint })
    this.emit('pending', request)
    return request
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => ({ ...entry.request }))
  }

  resolve(id: string, decision: PermissionDecision, reason = 'explicit'): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    clearTimeout(entry.timer)
    try { entry.respond(entry.adapter.response(decision)) } finally {
      this.emit('resolved', entry.request, decision, reason)
    }
    return true
  }

  clear(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, 'deny', 'shutdown')
    this.fingerprints.clear()
  }
}

export const permissionBroker = new PermissionBroker()
permissionBroker.setMaxListeners(100)
export const providerPermissionAdapters = ADAPTERS
