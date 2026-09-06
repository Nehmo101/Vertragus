import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * panelDirectory lives in the Electron entry and is awkward to construct in a
 * unit test. The mapping contract is small enough to pin by reading the
 * source: workspace hover is goalText, agent hover is taskText, latestTask
 * must not land on the workspace card.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

describe('panelDirectory hover mapping', () => {
  it('finds the mapper it polices', () => {
    expect(source).toContain('function panelDirectory')
    expect(source).toContain('agentCurrentTaskFields')
    expect(source).toContain('ws.goalText')
    expect(source).toContain('ws.orchestratorTaskText')
    expect(source).toContain('mcp.agentTask')
  })

  it('maps the workspace card from goalText, not workspaceTask/latestTask', () => {
    expect(source).toMatch(/\.\.\.\(ws\.goalText \? \{ goalText: ws\.goalText \} : \{\}\)/)
    // The old bug: mcp.workspaceTask onto workspace.taskText.
    expect(source).not.toMatch(/const taskText = mcp\.workspaceTask/)
    expect(source).not.toMatch(/\.\.\.\(taskText \? \{ taskText \}/)
  })

  it('maps each agent\'s current task onto agent.taskText', () => {
    expect(source).toContain('...agentCurrentTaskFields(ws.orchestratorTaskText)')
    expect(source).toContain('...agentCurrentTaskFields(agentTask)')
  })
})

describe('workspace focus CLI restore', () => {
  it('skips teammate restore and tiling when startMinimized or tabs', () => {
    expect(source).toMatch(/restoreMinimized:\s*!startMinimized/)
    expect(source).toMatch(/workspaceUsesTabChrome\(workspace\.workspaceId\)/)
    expect(source).toMatch(/suppressMoveTracking/)
  })
})

describe('focusWorkspace does not open the overview', () => {
  it('leaves the sheet to openTimeline / focusTimelineWindow', () => {
    const match = source.match(/focusWorkspace\(workspaceId\) \{[\s\S]*?\n\s{4}\},/)
    expect(match?.[0]).toBeTruthy()
    expect(match![0]).toContain('presentWorkspaceWindows')
    expect(match![0]).not.toContain('focusTimelineWindow')
    expect(source).toMatch(/openTimeline\(workspaceId\) \{[\s\S]*?focusTimelineWindow\(workspaceId\)/)
  })
})
