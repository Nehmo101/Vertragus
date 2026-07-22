/**
 * Per-(provider, workspace) pane-preflight bookkeeping, extracted from
 * AgentManager (audit A2). Failed runs cache the error's report too, so the
 * UI can show the last known verdict either way. AgentManager keeps the
 * public latestPreflight/preflightSlot facade — Engine feature-detects those
 * methods via `typeof`.
 */
import type { AgentProviderId } from '@shared/providers'
import type { PanePreflightReport } from '@shared/orchestrator'
import { PanePreflightError, type PanePreflightInput } from '@main/agents/panePreflight'
import { workspacePathKey } from '@main/agents/workspacePath'

export type PanePreflightRunner = (input: PanePreflightInput) => Promise<PanePreflightReport>

export class PreflightCache {
  private readonly reports = new Map<string, PanePreflightReport>()

  constructor(private readonly runner: PanePreflightRunner) {}

  private key(provider: AgentProviderId, workingDir: string): string {
    return `${provider}:${workspacePathKey(workingDir)}`
  }

  latest(provider: AgentProviderId, workingDir: string): PanePreflightReport | undefined {
    return this.reports.get(this.key(provider, workingDir))
  }

  async run(input: PanePreflightInput): Promise<PanePreflightReport> {
    try {
      const report = await this.runner(input)
      this.reports.set(this.key(input.provider, input.workingDir), report)
      return report
    } catch (error) {
      if (error instanceof PanePreflightError) {
        this.reports.set(this.key(input.provider, input.workingDir), error.report)
      }
      throw error
    }
  }
}
