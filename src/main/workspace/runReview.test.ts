import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { getRunReview } from './runReview'
import { createWorktree, defaultGitRunner } from '@main/agents/worktree'

it('recovers the root integration branch and distinguishes dirty worker work from committed results', async () => {
  const repo = await mkdtemp(join(tmpdir(),'vertragus-recovery-'))
  try {
    await defaultGitRunner(['init','-b','main'],repo)
    await writeFile(join(repo,'base.txt'),'base')
    await defaultGitRunner(['add','.'],repo)
    await defaultGitRunner(['-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','base'],repo)
    const root = await createWorktree(repo,'root','vertragus/run/root')
    const worker = await createWorktree(repo,'worker','vertragus/run/worker')
    await writeFile(join(worker.path,'pending.txt'),'pending')
    const dir = join(repo,'.vertragus/runs/run-1')
    await mkdir(dir,{recursive:true})
    await writeFile(join(dir,'meta.json'),JSON.stringify({workspaceId:'run-1',profileId:'profile',workspaceName:'Run',startedAt:1}))
    await writeFile(join(dir,'events.jsonl'),[
      {seq:1,ts:1,type:'agent_started',agentId:'root',name:'Root',roleId:'orchestrator',branch:root.branch,worktreePath:root.path},
      {seq:2,ts:2,type:'agent_started',agentId:'worker',name:'Worker',roleId:'worker',branch:worker.branch,worktreePath:worker.path},
      {seq:3,ts:3,type:'orchestrator_started',agentId:'root-new',name:'Root II',roleId:'orchestrator',predecessorAgentId:'root',eventCursor:2,providerId:'codex',model:'gpt-5.4',effort:'high'}
    ].map((event) => JSON.stringify(event)).join('\n'))
    const review = await getRunReview(repo,'profile','run-1')
    expect(review.baseBranch).toBe(root.branch)
    expect(review.seat).toEqual({providerId:'codex',model:'gpt-5.4',effort:'high'})
    expect(review.branches.find((entry) => !entry.root)).toMatchObject({dirty:true,ahead:0})
    await expect(getRunReview(repo,'foreign-profile','run-1')).rejects.toThrow('Unknown run')
    await expect(getRunReview(repo,'profile','../escape')).rejects.toThrow('Invalid run id')
  } finally { await rm(repo,{recursive:true,force:true}) }
},30_000)
