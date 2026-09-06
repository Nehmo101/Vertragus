import { afterEach, expect, it, vi } from 'vitest'
import { PendingQuestions } from '@main/mcp/pendingQuestions'
import { Workspace, type WorkspaceDeps } from './Workspace'
import { FakePty, FakeRegistry, FakeWindows, fakeSeed, fakeSpawn, fakeWorktrees, sequentialIds, testProfile, testProviders } from './testing'

const workspaces: Workspace[] = []
afterEach(async () => { await Promise.all(workspaces.splice(0).map((workspace) => workspace.close())) })

function harness(overrides: Partial<WorkspaceDeps> = {}) {
  const spawn = fakeSpawn({ptySystemPrompt:true})
  const seed = fakeSeed()
  const trees = fakeWorktrees()
  const questions = new PendingQuestions(sequentialIds('q'))
  const preflight = vi.fn(async () => undefined)
  const rotate = vi.fn()
  const revoke = vi.fn()
  let token = 1
  const workspace = new Workspace({profile:testProfile(),name:'Paradiso'}, {
    registry:new FakeRegistry(),windows:new FakeWindows(),providers:testProviders(),configDir:'/config',
    newId:sequentialIds('reseat'),createPty:()=>new FakePty(),readTokenUsage:async()=>undefined,
    spawn:spawn.spawn as unknown as WorkspaceDeps['spawn'],seed:seed.seed as unknown as WorkspaceDeps['seed'],
    createWorktree:trees.createWorktree as WorkspaceDeps['createWorktree'],
    writeSuccession:()=>undefined,preflightSeat:preflight,
    worktreeDeps:{git:async(args,cwd)=>({stdout: args[0]==='rev-parse'
      ? (args.includes('--abbrev-ref') ? trees.calls.find((tree)=>cwd.endsWith(tree.agentId))?.branchName ?? 'main' : 'a'.repeat(40)) : '',stderr:''})},
    ...overrides
  })
  workspace.attachMcp({orchestratorUrl:'http://localhost/mcp?token=root',
    subagentUrl:(id)=>`http://localhost/mcp?agent=${id}&token=${token}`,
    leadUrl:(id)=>`http://localhost/mcp?lead=${id}&token=${token}`,
    rotateSubagentToken:(id,kind)=>{rotate(id,kind);token++;return {subagentUrl:`http://localhost/mcp?agent=${id}&token=${token}`}},
    revokeSubagentToken:revoke,
    waitForSession:async()=>true
  })
  workspace.attachQuestions(questions)
  workspaces.push(workspace)
  return {workspace,spawn,seed,trees,questions,preflight,rotate,revoke}
}

it('Stop during deferred preflight cancels replacement before any new spawn', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = harness({ preflightSeat: () => gate })
  const worker = await h.workspace.startAgent({ role: 'worker', task: 'Parser' })
  h.questions.create(worker.agentId, 'Pause')
  const pending = h.workspace.reseatAgent({ agentId: worker.agentId, providerId: 'codex' }).ready
  const rejected = expect(pending).rejects.toThrow(/cancelled|stopped/i)
  await h.workspace.stopAgent(worker.agentId)
  release()
  await rejected
  expect(h.spawn.calls).toHaveLength(1)
  expect(h.spawn.calls[0].pty.isAlive).toBe(false)
  expect(h.rotate).not.toHaveBeenCalled()
})

it('a seed failure after replacement spawn kills the process and revokes its new credential', async () => {
  const seeded = fakeSeed()
  let count = 0
  const h = harness({ seed: async (...args) => {
    count++
    if (count > 1) throw new Error('seed failed')
    return seeded.seed(...args)
  } })
  const worker = await h.workspace.startAgent({ role: 'worker', task: 'Parser' })
  h.questions.create(worker.agentId, 'Pause')
  await expect(h.workspace.reseatAgent({ agentId: worker.agentId, providerId: 'codex' }).ready).rejects.toThrow('seed failed')
  expect(h.spawn.calls).toHaveLength(2)
  expect(h.spawn.calls[1].pty.isAlive).toBe(false)
  expect(h.revoke).toHaveBeenCalledWith(worker.agentId, 'subagent')
})

it('a lead replacement rotates its lead credential domain and retains the lead URL', async () => {
  const h = harness()
  await h.workspace.startOrchestrator()
  const lead = await h.workspace.startLead({ area: 'parser', task: 'Own parser' })
  h.questions.create(lead.agentId, 'Pause')
  await h.workspace.reseatAgent({ agentId: lead.agentId, providerId: 'codex' }).ready
  expect(h.rotate).toHaveBeenCalledWith(lead.agentId, 'lead')
  expect(h.spawn.calls.at(-1)?.input.mcpUrl).toContain(`lead=${lead.agentId}`)
})
