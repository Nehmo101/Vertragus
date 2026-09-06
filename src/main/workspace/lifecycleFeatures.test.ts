import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingQuestions } from '@main/mcp/pendingQuestions'
import type { AgentPty } from '@main/agents/spawn'
import { USER_QUESTION_AGENT_ID } from '@main/mcp/types'
import { answerAgentQuestion } from '@main/mcp/answerQuestion'
import { memoryTaskBoard } from '@main/mcp/testing'
import { Workspace, type WorkspaceDeps, type WorkspaceMcpUrls } from './Workspace'
import { FakePty, FakeRegistry, FakeWindows, fakeSeed, fakeSpawn, fakeWorktrees, sequentialIds, testProfile, testProviders } from './testing'

const active: Workspace[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((workspace) => workspace.close())) })

function harness(options: {
  deps?: Partial<WorkspaceDeps>
  profile?: ReturnType<typeof testProfile>
  wait?: WorkspaceMcpUrls['waitForSession']
} = {}) {
  const spawn = fakeSpawn({ptySystemPrompt:true})
  const seed = fakeSeed()
  const worktrees = fakeWorktrees()
  const registry = new FakeRegistry()
  const questions = new PendingQuestions(sequentialIds('question'))
  const rotate = vi.fn(() => ({subagentUrl:'http://localhost/rotated'}))
  const restore = vi.fn()
  const preflight = vi.fn(async () => undefined)
  const workspace = new Workspace({name:'Paradiso',profile:options.profile ?? testProfile()}, {
    registry,windows:new FakeWindows(),configDir:'/config',providers:testProviders(),
    createPty:()=>new FakePty(),newId:sequentialIds('lifecycle'),writeSuccession:()=>undefined,
    spawn:spawn.spawn as unknown as WorkspaceDeps['spawn'],seed:seed.seed as unknown as WorkspaceDeps['seed'],
    createWorktree:worktrees.createWorktree as WorkspaceDeps['createWorktree'],
    readTokenUsage:async()=>undefined,preflightSeat:preflight,
    worktreeDeps:{git:async(args)=>({stdout:args[0]==='rev-parse'?(args.includes('--abbrev-ref')?'main':'a'.repeat(40)):'',stderr:''})},
    ...options.deps
  })
  workspace.attachQuestions(questions)
  workspace.attachMcp({orchestratorUrl:'http://localhost/mcp?token=original',subagentUrl:id=>`http://localhost/mcp?agent=${id}`,
    leadUrl:id=>`http://localhost/mcp?lead=${id}`,rotateSubagentToken:rotate,restoreAgentContract:restore,waitForSession:options.wait ?? (async()=>true)})
  active.push(workspace)
  return {workspace,questions,spawn,seed,worktrees,registry,rotate,restore,preflight}
}

describe('provider choice and lifecycle boundaries', () => {
  it('retains accumulated runtime across switches without counting time while stopped', async () => {
    let now = 0
    const h = harness({ profile: testProfile({ maxRuntimeMin: 1 }), deps: { now: () => now } })
    const worker = await h.workspace.startAgent({ role: 'worker', task: 'Parser' })
    h.questions.create(worker.agentId, 'Pause')
    now = 20_000
    await h.workspace.reseatAgent({ agentId: worker.agentId, providerId: 'codex' }).ready
    expect(h.workspace.budget()).toMatchObject({ usedSec: 20, exhausted: false })
    now = 35_000
    await h.workspace.stopAgent(worker.agentId)
    now = 50_000
    expect(h.workspace.budget().usedSec).toBe(35)
    await h.workspace.reseatAgent({ agentId: worker.agentId, model: 'selected' }).ready
    now = 75_000
    expect(h.workspace.budget()).toMatchObject({ usedSec: 60, limitSec: 60, exhausted: true })
  })

  it('carries the latest assignment, owned tasks and helper permission into a replacement', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({ role: 'worker', task: 'Original task', canSpawnHelpers: true })
    const board = memoryTaskBoard()
    h.workspace.attachTaskBoard(board)
    board.create({ subject: 'Continue the parser', ownerAgentId: worker.agentId })
    board.create({ subject: 'Another agent task', ownerAgentId: 'elsewhere' })
    board.create({ subject: 'Abandoned task', ownerAgentId: worker.agentId })
    board.update('task-3', 1, 'delete')
    h.workspace.rememberAssignment(worker.agentId, 'The revised parser assignment')
    h.questions.create(worker.agentId, 'Pause')
    await h.workspace.reseatAgent({ agentId: worker.agentId, providerId: 'codex' }).ready
    const prompt = h.seed.prompts.at(-1)
    expect(prompt).toContain('The revised parser assignment')
    expect(prompt).toContain('Continue the parser')
    expect(prompt).toContain('MAY start_agent a helper')
    expect(prompt).not.toContain('Another agent task')
    expect(prompt).not.toContain('Abandoned task')
    expect(board.get('task-1')).toMatchObject({ ownerAgentId: worker.agentId, status: 'in_progress', revision: 1 })
  })

  it('refuses cutover when dirty facts remain without a snapshot error message', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({ role: 'worker', task: 'Parser' })
    h.questions.create(worker.agentId, 'Pause')
    vi.spyOn(h.workspace, 'snapshotDone').mockResolvedValue({ branch: worker.branch, headSha: 'a', uncommitted: true, changedFiles: ['src/parser.ts'], diffStat: '' })
    await expect(h.workspace.reseatAgent({ agentId: worker.agentId, providerId: 'codex' }).ready).rejects.toThrow('Worktree still contains uncommitted changes')
    expect(h.spawn.calls[0].pty.isAlive).toBe(true)
    expect(h.rotate).not.toHaveBeenCalled()
  })

  it('never spawns a replacement while the old process ignores termination', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({ role: 'worker', task: 'Parser' })
    h.questions.create(worker.agentId, 'Pause')
    const old = h.spawn.calls[0].pty
    const kill = vi.spyOn(old, 'kill').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      const pending = h.workspace.reseatAgent({ agentId: worker.agentId, providerId: 'codex' }).ready
      const rejected = expect(pending).rejects.toThrow('Previous process has not exited')
      await vi.advanceTimersByTimeAsync(5001)
      await rejected
      expect(h.spawn.calls).toHaveLength(1)
      expect(h.rotate).not.toHaveBeenCalled()
      expect(h.workspace.agentDiagnostic(worker.agentId)?.lastError).toContain('No replacement was started')
    } finally {
      vi.useRealTimers()
      kill.mockRestore()
      old.kill()
    }
  })

  it('switches an MCP worker to sentinel reporting and delivers its existing question through the new PTY', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    const question = h.questions.create(worker.agentId,'Which parser?',{choices:['Strict','Tolerant']})
    await h.workspace.reseatAgent({agentId:worker.agentId,providerId:'ollama',model:'local'}).ready
    expect(h.seed.prompts.at(-1)).toContain('Strict')
    expect(h.seed.prompts.at(-1)).toContain('sentinel')
    expect(h.workspace.listAgents()[0].reporting).toBe('sentinel')
    const result = await answerAgentQuestion(h.questions,worker.agentId,question.questionId,'Strict')
    expect(result.ok).toBe(true)
    expect(h.seed.prompts.at(-1)).toContain('Strict\n\n')
    expect(h.questions.openForAgent(worker.agentId)).toBeUndefined()
  })

  it('switches a sentinel question to MCP ticket resumption without typing through its old callback', async () => {
    const h = harness({profile:testProfile({slots:[{id:'local',roleId:'worker',providerId:'ollama'}]})})
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    const delivery = vi.fn(async()=>undefined)
    const question = h.questions.create(worker.agentId,'Which parser?',{deliverAnswer:delivery})
    await h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'}).ready
    const wait = h.questions.waitForAnswer(question.questionId,worker.agentId,1000)
    expect((await answerAgentQuestion(h.questions,worker.agentId,question.questionId,'Strict')).ok).toBe(true)
    expect(await wait).toMatchObject({state:'answered',answer:'Strict'})
    expect(delivery).not.toHaveBeenCalled()
    expect(h.seed.prompts.at(-1)).toContain('Resume ask_orchestrator')
  })

  it('refuses a stopped identity when its slot or workspace capacity has been reused', async () => {
    const h = harness({profile:testProfile({maxSubagents:1,slots:[
      {id:'one',roleId:'worker',providerId:'claude',maxCount:1},
      {id:'two',roleId:'reviewer',providerId:'claude'}]})})
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    await h.workspace.stopAgent(worker.agentId)
    const replacement = await h.workspace.startAgent({role:'worker',task:'Next'})
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'})).toThrow(/limit/)
    await h.workspace.stopAgent(replacement.agentId)
    await h.workspace.startAgent({role:'reviewer',task:'Review'})
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'})).toThrow(/Workspace agent limit/)
    expect(h.preflight).not.toHaveBeenCalled()
  })

  it('preserves the human ticket on successful root replacement and refreshes MCP timeout capabilities', async () => {
    const providers=testProviders().map(provider=>({...provider,mcpToolTimeoutSec:provider.id==='claude'?400:undefined}))
    const h = harness({deps:{providers}})
    await h.workspace.startOrchestrator()
    const context = h.workspace.mcpContext()
    const ticket = h.questions.create(USER_QUESTION_AGENT_ID,'Choose target',{choices:['A','B']})
    expect(context.awaitTimeout).toBeDefined()
    expect(()=>h.workspace.requestSuccession({reason:'provider_switch',successor:{providerId:'ollama'}})).toThrow(/requires an MCP/)
    await h.workspace.replaceOrchestratorFromHost({providerId:'codex'})
    expect(context.awaitTimeout).toBeUndefined()
    expect(h.questions.openForAgent(USER_QUESTION_AGENT_ID)).toMatchObject({questionId:ticket.questionId,choices:['A','B']})
  })

  it('serializes model changes against succession and message delivery during preflight', async () => {
    let release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    const h=harness({deps:{preflightSeat:()=>gate}})
    await h.workspace.startOrchestrator()
    const worker=await h.workspace.startAgent({role:'worker',task:'Parser'})
    h.questions.create(worker.agentId,'Pause')
    const pending=h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'}).ready
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'})).toThrow('already_in_progress')
    await expect(h.workspace.replaceOrchestratorFromHost()).rejects.toThrow('already_in_progress')
    await expect(h.workspace.sendToAgent(worker.agentId,'Another task')).rejects.toThrow(/replacement is in progress/)
    expect(h.workspace.listAgents()[0].status).toBe('starting')
    release()
    await pending
  })

  it('uses the selected slot and the next free slot for its reporting dialect', async () => {
    const h = harness({profile:testProfile({slots:[
      {id:'mcp',roleId:'worker',providerId:'claude',maxCount:1},
      {id:'pty',roleId:'worker',providerId:'ollama',maxCount:1}
    ]})})
    expect(h.workspace.reportingMode('worker',{providerId:'ollama'})).toBe('sentinel')
    expect(h.workspace.reportingMode('worker',{slotId:'pty'})).toBe('sentinel')
    expect(h.workspace.reportingMode('worker')).toBe('mcp')
    await h.workspace.startAgent({role:'worker',task:'first'})
    expect(h.workspace.reportingMode('worker')).toBe('sentinel')
    expect(()=>h.workspace.reportingMode('worker',{slotId:'missing'})).toThrow(/Unknown slotId/)
  })

  it('refuses no-op, root and incompatible structured-result switches before preflight', async () => {
    const h = harness()
    const root = await h.workspace.startOrchestrator()
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser',resultSchema:{type:'object'}})
    h.questions.create(worker.agentId,'Which format?')
    expect(()=>h.workspace.reseatAgent({agentId:root.agentId,providerId:'codex'})).toThrow(/succession/)
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId})).toThrow(/already uses/)
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId,providerId:'ollama'})).toThrow(/requires MCP/)
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId,providerId:'missing'})).toThrow(/Unknown provider/)
    expect(h.preflight).not.toHaveBeenCalled()
  })

  it('keeps the live process when its snapshot cannot preserve the current work', async () => {
    const h = harness()
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    h.questions.create(worker.agentId,'Pause')
    vi.spyOn(h.workspace,'snapshotDone').mockResolvedValue({branch:worker.branch,headSha:'a',uncommitted:true,changedFiles:['src/a.ts'],diffStat:'',snapshotError:'index is locked'})
    await expect(h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'}).ready).rejects.toThrow('index is locked')
    expect(h.spawn.calls[0].pty.isAlive).toBe(true)
    expect(h.rotate).not.toHaveBeenCalled()
    expect(h.workspace.agentDiagnostic(worker.agentId)?.lastError).toBe('index is locked')
  })

  it('retries the selected failed seat and restores its structured contract', async () => {
    let failing = true
    const h = harness({deps:{preflightSeat:async()=>{if(failing) throw new Error('not logged in')}}})
    const schema = {type:'object' as const,required:['ok'],properties:{ok:{type:'boolean' as const}}}
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser',resultSchema:schema})
    h.questions.create(worker.agentId,'Pause')
    await expect(h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex',model:'selected',effort:'high'}).ready).rejects.toThrow('not logged in')
    failing = false
    await h.workspace.reseatAgent({agentId:worker.agentId,reason:'startup_retry'}).ready
    expect(h.spawn.calls.at(-1)?.input).toMatchObject({provider:{id:'codex'},model:'selected',effort:'high'})
    expect(h.restore).toHaveBeenCalledWith(worker.agentId,schema,undefined)
    expect(h.workspace.agentDiagnostic(worker.agentId)?.lastError).toBeUndefined()
  })

  it('bounds repeated failures while retaining the original process and question', async () => {
    const h = harness({deps:{preflightSeat:async()=>{throw new Error('unavailable')}}})
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    const ticket = h.questions.create(worker.agentId,'Pause')
    for(let i=0;i<4;i++) await expect(h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'}).ready).rejects.toThrow('unavailable')
    expect(()=>h.workspace.reseatAgent({agentId:worker.agentId,providerId:'codex'})).toThrow(/four times/)
    expect(h.questions.openForAgent(worker.agentId)?.questionId).toBe(ticket.questionId)
    expect(h.spawn.calls[0].pty.isAlive).toBe(true)
  })

  it('fails root preflight before changing its token, process or user question', async () => {
    const h = harness({deps:{preflightSeat:async()=>{throw new Error('not installed')}}})
    const root = await h.workspace.startOrchestrator()
    const ticket = h.questions.create(USER_QUESTION_AGENT_ID,'Which target?')
    const before = h.workspace.orchToken
    await expect(h.workspace.replaceOrchestratorFromHost({providerId:'codex'})).rejects.toThrow('not installed')
    expect(h.workspace.orchestrator?.agentId).toBe(root.agentId)
    expect(h.workspace.orchToken).toBe(before)
    expect(h.spawn.calls[0].pty.isAlive).toBe(true)
    expect(h.questions.openForAgent(USER_QUESTION_AGENT_ID)?.questionId).toBe(ticket.questionId)
    expect(h.worktrees.calls).toHaveLength(1)
  })

  it('retains a timed-out MCP phase and explicitly retries its unsubmitted startup', async () => {
    let connected = false
    const h = harness({wait:async()=>connected})
    const worker = await h.workspace.startAgent({role:'worker',task:'Parser'})
    await vi.waitFor(()=>expect(h.workspace.agentDiagnostic(worker.agentId)?.lastError).toMatch(/startup deadline/))
    expect(h.workspace.agentDiagnostic(worker.agentId)?.boot.phase).toBe('waiting')
    connected = true
    await h.workspace.reseatAgent({agentId:worker.agentId,reason:'startup_retry'}).ready
    expect(h.workspace.agentDiagnostic(worker.agentId)).toMatchObject({generation:2,boot:{phase:null}})
    expect(h.seed.options[0]?.autoSubmit).toBe(false)
    expect(h.seed.options.at(-1)?.autoSubmit).toBe(true)
  })

  it('checks Stop inside the delayed executable-resolution spawn callback', async () => {
    let release!:()=>void
    const gate = new Promise<void>(resolve=>{release=resolve})
    let reached = false
    let admitted: AgentPty | undefined
    const h = harness({deps:{spawn:async(_input,deps)=>{
      reached=true
      await gate
      admitted=deps?.createPty?.()
      throw new Error('The stopped start must never reach this point')
    }}})
    const start = h.workspace.startOrchestrator()
    const rejected = expect(start).rejects.toThrow(/closed|cancelled/)
    await vi.waitFor(()=>expect(reached).toBe(true))
    await h.workspace.close()
    release()
    await rejected
    expect(admitted).toBeUndefined()
    expect(h.registry.listAgents()).toHaveLength(0)
  })
})
