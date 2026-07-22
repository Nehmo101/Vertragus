/**
 * Ready-made workspace profile presets beyond DEFAULT_PROFILE.
 */
import { workspaceProfileSchema, type WorkspaceProfile } from './profile'

/**
 * Efficiency-Solo: one single agent works on the goal directly. There is no
 * orchestrator process, no delegation roundtrip and no plan-DAG ceremony —
 * the entire fixed token cost of the orchestrator contract (~90 prompt lines
 * plus the full MCP tool-schema block per turn) is skipped. The agent still
 * receives the human-reviewed retro-learnings overlay and a minimal MCP
 * surface (report_activity, record_retro), so it benefits from and feeds the
 * team knowledge loop. See docs/EFFICIENCY_SOLO.md.
 */
export const EFFICIENCY_SOLO_PROFILE: WorkspaceProfile = workspaceProfileSchema.parse({
  id: 'efficiency-solo',
  name: 'Efficiency Solo',
  workingDir: '',
  agents: [
    {
      role: 'solo',
      provider: 'claude',
      model: '',
      modelPreset: 'balanced',
      count: 1,
      orchestrated: false,
      yolo: false,
      strengths: [],
      weaknesses: []
    }
  ],
  solo: true,
  yoloDefault: false,
  planner: { mode: 'manual', routingMode: 'fixed', maxParallel: 1, maxRetries: 0 },
  benchmark: { enabled: false },
  multiAgent: { enabled: false, stopLosers: true },
  autoPr: { mode: 'off' },
  autoGit: { enabled: false, targetBranch: '' }
})
