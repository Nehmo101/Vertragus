/**
 * E5: the loop eval — the orchestration loop's GIT HALF over a real repository.
 *
 * A temp repo carries a planted bug. A real {@link Workspace} (fake spawn/seed —
 * no CLI processes — but REAL `git worktree` machinery) starts an orchestrator
 * and a worker; the "worker" fixes the bug in its own worktree and reports done,
 * which snapshots the fix into a commit on the worker's branch (C3). The
 * assertions are the loop's promises:
 *
 * - `inspect_agent` (host path) shows the fixed file in the worker's worktree,
 * - a tester started with `baseBranch` on the worker's branch SEES the fix in
 *   its own checkout (C4 chaining is real, not prompt prose),
 * - the tester reports success with nothing uncommitted (it changed nothing),
 * - the orchestrator's worktree carries NO diff of its own — it delegated.
 *
 * No sleeps: every git step is awaited; the fakes resolve immediately.
 */
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PendingQuestions } from '@main/mcp/pendingQuestions'
import { Workspace, type WorkspaceDeps } from '@main/workspace/Workspace'
import {
  FakePty,
  FakeRegistry,
  FakeWindows,
  fakeSeed,
  fakeSpawn,
  sequentialIds,
  testProfile,
  testProviders
} from '@main/workspace/testing'

const execFileAsync = promisify(execFile)
const TEST_TIMEOUT = 30_000

const BUGGY = 'export const add = (a, b) => a - b\n'
const FIXED = 'export const add = (a, b) => a + b\n'

/**
 * Fresh `git worktree add` checkouts materialize with the platform's line
 * endings (autocrlf on the Windows CI runner), so full-content assertions
 * compare normalized text — the diff under test is `a + b` vs `a - b`,
 * never CRLF vs LF.
 */
const normalized = (text: string): string => text.replace(/\r\n/g, '\n')

let repo: string

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=Eval', '-c', 'user.email=eval@localhost', ...args],
    { cwd: repo, windowsHide: true }
  )
  return stdout
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'vertragus-loop-eval-'))
  await git(['init', '--initial-branch=main'])
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src', 'math.js'), BUGGY, 'utf8')
  await git(['add', '-A'])
  await git(['commit', '-m', 'seed: math with a planted bug', '--no-verify'])
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

function buildWorkspace(): Workspace {
  const workspace = new Workspace(
    {
      profile: testProfile({
        repoPath: repo,
        slots: [
          { id: 'slot-worker', roleId: 'worker', providerId: 'claude' },
          { id: 'slot-tester', roleId: 'tester', providerId: 'claude' }
        ]
      }),
      name: 'Eval'
    },
    {
      registry: new FakeRegistry(),
      windows: new FakeWindows(),
      configDir: join(repo, '.vertragus-config'),
      providers: testProviders(),
      // Fake processes, REAL worktrees: createWorktree/worktreeDeps stay unset.
      spawn: fakeSpawn().spawn as unknown as WorkspaceDeps['spawn'],
      seed: fakeSeed().seed as unknown as WorkspaceDeps['seed'],
      createPty: () => new FakePty(),
      newId: sequentialIds('agent')
    }
  )
  workspace.attachMcp({
    orchestratorUrl: 'http://127.0.0.1:1/mcp?ws=w&token=orch',
    subagentUrl: (agentId) => `http://127.0.0.1:1/mcp?ws=w&agent=${agentId}&token=sub`,
    leadUrl: (agentId) => `http://127.0.0.1:1/mcp?ws=w&lead=${agentId}&token=lead`
  })
  workspace.attachQuestions(new PendingQuestions(sequentialIds('q'), () => 1))
  return workspace
}

describe('E5 loop eval — fix travels worker → snapshot → tester, orchestrator stays clean', () => {
  it(
    'runs the whole chain on a real repository',
    async () => {
      const workspace = buildWorkspace()
      try {
        const orchestrator = await workspace.startOrchestrator()
        await workspace.assignGoal('Fix the bug in src/math.js: add() must add.')
        expect(workspace.goalText).toContain('src/math.js')

        // The "worker" fixes the bug in ITS OWN worktree — nobody touches the
        // repository's main checkout.
        const worker = await workspace.startAgent({
          role: 'worker',
          task: 'Fix add() in src/math.js.'
        })
        expect(worker.worktreePath).not.toBe(repo)
        await writeFile(join(worker.worktreePath, 'src', 'math.js'), FIXED, 'utf8')

        // report_done → C3 snapshot: the dirty worktree becomes a commit.
        const facts = await workspace.snapshotDone(worker.agentId, 'Fixed add to a + b.')
        expect(facts.uncommitted).toBe(false)
        expect(facts.branch).toBe(worker.branch)
        expect(facts.headSha).toMatch(/^[0-9a-f]{40}$/)
        expect(facts.changedFiles).toContain('src/math.js')

        // The orchestrator verifies with inspect_agent's host path, not trust.
        const inspected = await workspace.inspectAgent(worker.agentId, {
          view: 'file',
          path: 'src/math.js'
        })
        expect(inspected.body).toContain('a + b')

        // C4 chaining is real: a tester on the worker's branch SEES the fix.
        const tester = await workspace.startAgent({
          role: 'tester',
          task: 'Verify add() adds.',
          baseBranch: facts.branch!
        })
        const testerCopy = await readFile(join(tester.worktreePath, 'src', 'math.js'), 'utf8')
        expect(normalized(testerCopy)).toBe(FIXED)

        // The tester "ran the check" and reports success having changed nothing:
        // no snapshot commit, no uncommitted leftovers.
        const testerFacts = await workspace.snapshotDone(tester.agentId, 'add() adds — verified.')
        expect(testerFacts.uncommitted).toBe(false)
        expect(testerFacts.changedFiles ?? []).toHaveLength(0)

        // The orchestrator delegated: its own worktree carries no diff at all,
        // and still holds the BUGGY original it branched from.
        const orchestratorPath = orchestrator.worktreePath
        const status = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: orchestratorPath,
          windowsHide: true
        })
        expect(status.stdout.trim()).toBe('')
        const orchestratorCopy = await readFile(join(orchestratorPath, 'src', 'math.js'), 'utf8')
        expect(normalized(orchestratorCopy)).toBe(BUGGY)

        // And the repository's own checkout on main never moved either.
        expect(normalized(await readFile(join(repo, 'src', 'math.js'), 'utf8'))).toBe(BUGGY)
        expect(orchestrator.agentId).not.toBe(worker.agentId)
      } finally {
        await workspace.close()
      }
    },
    TEST_TIMEOUT
  )
})
