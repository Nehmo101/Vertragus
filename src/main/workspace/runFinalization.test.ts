import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { abortRunFinalizations, finalizeRunPullRequest, readRunFinalization, retryRunFinalization, waitForRunFinalizations } from './runFinalization'

it('names missing, invalid and corrupt persisted states instead of inventing success',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'vertragus-state-'))
  try {
    expect(await readRunFinalization(repo,'missing')).toBeUndefined()
    await expect(retryRunFinalization(repo,'missing')).rejects.toThrow('no pending')
    await expect(readRunFinalization(repo,'../escape')).rejects.toThrow('Invalid run id')
    const dir=join(repo,'.vertragus/runs/corrupt');await mkdir(dir,{recursive:true})
    await writeFile(join(dir,'finalization.json'),'{broken')
    await expect(readRunFinalization(repo,'corrupt')).rejects.toThrow(SyntaxError)
  } finally {await rm(repo,{recursive:true,force:true})}
})

it('deduplicates an archive retry and aborts it during shutdown while persisting the failure',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'vertragus-live-finalization-'))
  const input={repoPath:repo,head:'run',base:'main',remote:'origin',title:'Run',body:''}
  let entered!:()=>void
  const started=new Promise<void>((resolve)=>{entered=resolve})
  const open=vi.fn(async(_input:unknown,deps?:import('@main/agents/pullRequest').PullRequestDeps)=>{
    entered()
    await new Promise<void>((_resolve,reject)=>deps?.signal?.addEventListener('abort',()=>reject(deps.signal?.reason),{once:true}))
    return {ok:true as const,url:'https://github.com/a/b/pull/1',created:true}
  })
  try {
    const first=finalizeRunPullRequest(repo,'run-1',input,{},open)
    expect(finalizeRunPullRequest(repo,'run-1',input,{},open)).toBe(first)
    await started
    expect(await readRunFinalization(repo,'run-1')).toMatchObject({status:'running'})
    abortRunFinalizations()
    await waitForRunFinalizations()
    expect(await first).toMatchObject({ok:false,reason:'gh_failed'})
    expect(await readRunFinalization(repo,'run-1')).toMatchObject({status:'failed',error:expect.stringContaining('shutdown')})
    expect(open).toHaveBeenCalledTimes(1)
  } finally {await rm(repo,{recursive:true,force:true})}
})

it('persists an aborted attempt for an explicit later retry without making a network call', async () => {
  const repo = await mkdtemp(join(tmpdir(),'vertragus-abort-'))
  const controller = new AbortController()
  controller.abort(new Error('app shutdown'))
  const git = vi.fn(async()=>({stdout:'',stderr:''}))
  try {
    await finalizeRunPullRequest(repo,'run-1',{repoPath:repo,head:'run',base:'main',remote:'origin',title:'Run',body:''},{git,signal:controller.signal})
    expect(git).not.toHaveBeenCalled()
    expect(await readRunFinalization(repo,'run-1')).toMatchObject({status:'failed',error:'app shutdown'})
  } finally {await rm(repo,{recursive:true,force:true})}
})

it('persists failed attempts and retries after reopening state without duplicating completed PRs', async () => {
  const repo = await mkdtemp(join(tmpdir(),'vertragus-finalization-'))
  const git = vi.fn(async () => ({stdout:'',stderr:''}))
  const gh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({stdout:'https://github.com/a/b/pull/1',stderr:''})
  try {
    await finalizeRunPullRequest(repo,'run-1',{repoPath:repo,head:'vertragus/run/root',base:'main',remote:'origin',title:'Run',body:'Summary'},{git,gh})
    expect(await readRunFinalization(repo,'run-1')).toMatchObject({status:'failed',attempts:1,error:'offline'})
    const recovered = await retryRunFinalization(repo,'run-1',{git,gh})
    expect(recovered).toMatchObject({status:'completed',attempts:2,url:'https://github.com/a/b/pull/1'})
    await retryRunFinalization(repo,'run-1',{git,gh})
    expect(gh).toHaveBeenCalledTimes(2)
    const path = join(repo,'.vertragus/runs/run-1/finalization.json')
    const persisted = JSON.parse(await readFile(path,'utf8'))
    await writeFile(path,JSON.stringify({...persisted,status:'running'}))
    expect(await readRunFinalization(repo,'run-1')).toMatchObject({status:'failed',error:expect.stringContaining('interrupted')})
  } finally { await rm(repo,{recursive:true,force:true}) }
})
