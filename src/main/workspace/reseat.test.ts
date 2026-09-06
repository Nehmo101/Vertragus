import { afterEach, describe, expect, it, vi } from 'vitest'
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
    rotateSubagentToken:(id)=>{rotate(id);token++;return {subagentUrl:`http://localhost/mcp?agent=${id}&token=${token}`}},
    waitForSession:async()=>true
  })
  workspace.attachQuestions(questions)
  workspaces.push(workspace)
  return {workspace,spawn,seed,trees,questions,preflight,rotate}
}

describe('explicit reseat behavior', () => {
  it('does not attribute the predecessor usage cache to the replacement provider',async()=>{
    const oldUsage={kind:'consumption' as const,input:80,output:20,total:100}
    const h=harness({readTokenUsage:async(input)=>input.source.kind==='claude-jsonl'?oldUsage:undefined})
    const worker=await h.workspace.startAgent({role:'worker',task:'Parser'})
    expect(await h.workspace.readTokenUsage(worker.agentId)).toEqual(oldUsage)
    h.questions.create(worker.agentId,'Pause')
    await h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'}).ready
    expect(h.workspace.agentDiagnostic(worker.agentId)?.providerId).toBe('codex')
    expect(h.workspace.lastTokenUsage(worker.agentId)).toBeUndefined()
    expect(await h.workspace.readTokenUsage(worker.agentId)).toBeUndefined()
  })

  it('uses a fresh CLI usage session when changing models within the same provider',async()=>{
    let originalSession: string | undefined
    const h=harness({readTokenUsage:async(input)=>{
      originalSession ??= input.sessionId
      return input.sessionId===originalSession ? {kind:'consumption',input:80,output:20,total:100} : undefined
    }})
    const worker=await h.workspace.startAgent({role:'worker',task:'Parser'})
    await h.workspace.readTokenUsage(worker.agentId)
    h.questions.create(worker.agentId,'Pause')
    await h.workspace.reseatAgent({agentId:worker.agentId,model:'opus'}).ready
    expect(h.spawn.calls.at(-1)!.input.sessionId).not.toBe(h.spawn.calls[0]!.input.sessionId)
    expect(await h.workspace.readTokenUsage(worker.agentId)).toBeUndefined()
  })

  it('retains worker identity, branch and question while rebuilding the provider contract and generation', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({role:'worker',task:'Implement the parser.'})
    const ticket = h.questions.create(worker.agentId,'Which interface?')
    const result = await h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex',model:'gpt-5.4',effort:'high',note:'Keep the parser API.'}).ready
    expect(result).toMatchObject({agentId:worker.agentId,worktreePath:worker.worktreePath,branch:worker.branch})
    expect(h.trees.calls).toHaveLength(1)
    expect(h.spawn.calls[0]!.pty.isAlive).toBe(false)
    expect(h.spawn.calls[1]!.input).toMatchObject({provider:{id:'codex'},model:'gpt-5.4',effort:'high',cwd:worker.worktreePath})
    expect(h.spawn.calls[1]!.input.mcpUrl).not.toBe(h.spawn.calls[0]!.input.mcpUrl)
    expect(h.workspace.agentDiagnostic(worker.agentId)).toMatchObject({providerId:'codex',generation:2})
    expect(h.questions.openForAgent(worker.agentId)?.questionId).toBe(ticket.questionId)
    expect(h.seed.prompts.at(-1)).toContain('Implement the parser.')
    expect(h.seed.prompts.at(-1)).toContain('report_done')
    expect(h.seed.prompts.at(-1)).toContain('Keep the parser API.')
  })

  it('refuses a busy agent before preflight or killing its process', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({role:'worker',task:'Still working'})
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'})).toThrow(/busy/i)
    expect(h.preflight).not.toHaveBeenCalled()
    expect(h.spawn.calls[0]!.pty.isAlive).toBe(true)
  })

  it('leaves the current process alive when the replacement preflight fails', async () => {
    const h = harness({preflightSeat:async()=>{throw new Error('provider unavailable')}})
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    h.questions.create(worker.agentId,'Pause')
    await expect(h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'}).ready).rejects.toThrow('provider unavailable')
    expect(h.spawn.calls[0]!.pty.isAlive).toBe(true)
    expect(h.rotate).not.toHaveBeenCalled()
    expect(h.spawn.calls).toHaveLength(1)
  })

  it('retries a stopped worker in its retained checkout and slot', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    await h.workspace.stopAgent(worker.agentId)
    const restarted = await h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'}).ready
    expect(restarted.agentId).toBe(worker.agentId)
    expect(h.trees.calls).toHaveLength(1)
    expect(h.workspace.agentDiagnostic(worker.agentId)?.generation).toBe(2)
    expect(h.spawn.calls.at(-1)!.pty.isAlive).toBe(true)
  })

  it('starts a root successor from the predecessor integration branch with the selected seat', async () => {
    const h = harness()
    const root = await h.workspace.startOrchestrator()
    const successor = await h.workspace.replaceOrchestratorFromHost({providerId:'codex',model:'gpt-5.4',effort:'high'})
    expect(h.trees.calls.at(-1)?.startPoint).toBe(root.branch)
    expect(successor.agentId).not.toBe(root.agentId)
    expect(h.spawn.calls.at(-1)!.input).toMatchObject({provider:{id:'codex'},model:'gpt-5.4',effort:'high'})
    expect(h.workspace.orchestratorAlive).toBe(true)
    expect(h.spawn.calls[0]!.pty.isAlive).toBe(false)
  })
})
