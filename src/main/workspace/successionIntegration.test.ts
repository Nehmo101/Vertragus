import { expect, it } from 'vitest'
import { Workspace, type WorkspaceDeps } from './Workspace'
import { FakePty, FakeRegistry, FakeWindows, fakeSeed, fakeSpawn, fakeWorktrees, sequentialIds, testProfile, testProviders } from './testing'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

it('settles incumbent merges before branching and routes later adoption to the successor', async () => {
  const firstMerge = gate()
  const mergeEntered = gate()
  const successorTree = gate()
  const treeEntered = gate()
  const trees = fakeWorktrees()
  const spawn = fakeSpawn({ ptySystemPrompt: true })
  const seed = fakeSeed()
  const merges: string[] = []
  let treeCalls = 0
  const workspace = new Workspace({ profile: testProfile({ automation: { autoIntegrate: true } }), name: 'Paradiso' }, {
    registry: new FakeRegistry(), windows: new FakeWindows(), providers: testProviders(), configDir: '/config',
    newId: sequentialIds('integration'), createPty: () => new FakePty(), readTokenUsage: async () => undefined,
    spawn: spawn.spawn, seed: seed.seed, writeSuccession: () => undefined,
    createWorktree: async (...args) => {
      treeCalls++
      if (treeCalls === 3) { treeEntered.release(); await successorTree.promise }
      return trees.createWorktree(...args)
    },
    worktreeDeps: { git: async (args, cwd) => {
      if (args.includes('merge')) {
        merges.push(cwd)
        if (merges.length === 1) { mergeEntered.release(); await firstMerge.promise }
      }
      return { stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : '', stderr: '' }
    } }
  } as WorkspaceDeps)
  workspace.attachMcp({ orchestratorUrl: 'http://localhost/mcp?token=root', subagentUrl: (id) => `http://localhost/mcp?agent=${id}`, leadUrl: (id) => `http://localhost/mcp?lead=${id}`, waitForSession: async () => true })
  try {
    const incumbent = await workspace.startOrchestrator()
    const worker = await workspace.startAgent({ role: 'worker', task: 'Parser' })
    const adoptedFirst = workspace.adoptOnDone(worker.agentId, 'success')
    await mergeEntered.promise
    const succession = workspace.requestSuccession({ reason: 'context_full' })
    void succession.ready.catch(() => undefined)
    await turn()
    expect(treeCalls).toBe(2)
    firstMerge.release()
    await adoptedFirst
    await treeEntered.promise
    const adoptedSecond = workspace.adoptOnDone(worker.agentId, 'success')
    await turn()
    expect(merges).toEqual([incumbent.worktreePath])
    successorTree.release()
    const successor = await succession.ready
    await adoptedSecond
    expect(merges).toEqual([incumbent.worktreePath, successor.worktreePath])
    expect(trees.calls.at(-1)?.startPoint).toBe(incumbent.branch)
  } finally {
    firstMerge.release()
    successorTree.release()
    await workspace.close()
  }
})
