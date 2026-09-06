import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { openPullRequest, type OpenPullRequestInput, type PullRequestDeps, type PullRequestOutcome } from '@main/agents/pullRequest'
import type { RunFinalization } from '@shared/runReview'
import { runDir } from './journal'

const schema = z.object({
  status: z.enum(['pending', 'running', 'failed', 'completed']),
  updatedAt: z.number(), attempts: z.number(), error: z.string().optional(), url: z.string().optional(),
  input: z.object({repoPath:z.string(),head:z.string(),base:z.string(),remote:z.string(),title:z.string(),body:z.string(),draft:z.boolean().optional()})
})
type Saved = z.infer<typeof schema>
const pending = new Map<string, Promise<PullRequestOutcome>>()
const controllers = new Map<string, AbortController>()
export function abortRunFinalizations(): void {
  for (const controller of controllers.values()) controller.abort(new Error('Finalization interrupted by app shutdown. Retry from the run archive.'))
}
export async function waitForRunFinalizations(): Promise<void> {
  await Promise.allSettled([...pending.values()])
}
function pathFor(repoPath: string, workspaceId: string): string {
  if (!/^[\w-]+$/.test(workspaceId)) throw new Error('Invalid run id')
  return join(runDir(repoPath, workspaceId), 'finalization.json')
}
async function save(repo: string, id: string, state: Saved): Promise<void> {
  const path = pathFor(repo, id)
  await mkdir(runDir(repo, id), {recursive:true})
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2))
  await rename(`${path}.tmp`, path)
}
async function read(repo: string, id: string): Promise<Saved | undefined> {
  try { return schema.parse(JSON.parse(await readFile(pathFor(repo,id), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function readRunFinalization(repo: string, id: string): Promise<RunFinalization | undefined> {
  const state = await read(repo,id)
  if (!state) return undefined
  const view: RunFinalization = {status:state.status,updatedAt:state.updatedAt,attempts:state.attempts,error:state.error,url:state.url}
  // A persisted running attempt with no process-local owner was interrupted.
  return view.status === 'running' && !pending.has(pathFor(repo,id))
    ? {...view,status:'failed',error:'Finalization was interrupted. Retry to continue.'} : view
}
export function finalizeRunPullRequest(repo: string, id: string, input: OpenPullRequestInput, deps: PullRequestDeps = {}, open: typeof openPullRequest = openPullRequest): Promise<PullRequestOutcome> {
  const key = pathFor(repo,id)
  const active = pending.get(key)
  if (active) return active
  const controller = new AbortController()
  controllers.set(key,controller)
  const bounded = {...deps,signal:deps.signal ? AbortSignal.any([deps.signal,controller.signal]) : controller.signal}
  const operation = (async () => {
    const previous = await read(repo,id)
    if (previous?.status === 'completed' && previous.url) return {ok:true as const,url:previous.url,created:false}
    const state: Saved = {input: {...input,repoPath:repo},status:'running',attempts:(previous?.attempts ?? 0)+1,updatedAt:Date.now()}
    await save(repo,id,state)
    let outcome: PullRequestOutcome
    try { outcome = await open(state.input,bounded) }
    catch (error) { outcome = {ok:false,reason:'gh_failed',message:String(error)} }
    await save(repo,id,{...state,status:outcome.ok?'completed':'failed',updatedAt:Date.now(),...(outcome.ok?{url:outcome.url}:{error:outcome.message})})
    return outcome
  })().finally(() => {pending.delete(key);controllers.delete(key)})
  pending.set(key,operation)
  return operation
}
export async function retryRunFinalization(repo: string,id: string,deps: PullRequestDeps = {}): Promise<RunFinalization> {
  const state = await read(repo,id)
  if (!state) throw new Error('This run has no pending pull request finalization.')
  await finalizeRunPullRequest(repo,id,state.input,deps)
  return (await readRunFinalization(repo,id))!
}
