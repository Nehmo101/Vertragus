import { expect, it, vi } from 'vitest'
import { registerOrchestratorTools } from './toolsOrchestrator'
import { callTool, captureTools, fakeRuntime } from './testing'
import type { ReseatInput } from '@shared/schema/reseat'

async function setup() {
  const runtime = fakeRuntime()
  const agent = runtime.host.beginAgent({role:'worker',task:'Complete the parser'})
  await agent.ready
  const tools = captureTools(server=>registerOrchestratorTools(server,runtime))
  return {runtime,tools,agent}
}

it('returns a reserved generation immediately and observes asynchronous replacement failure', async () => {
  const h = await setup()
  let reject!: (error:Error)=>void
  const ready = new Promise<never>((_resolve,fail)=>{reject=fail})
  const reseat = vi.fn((input:ReseatInput)=>({agentId:input.agentId,generation:2,ready}))
  Object.assign(h.runtime.host,{reseatAgent:reseat})
  const result = await callTool(h.tools,'reseat_agent',{agentId:h.agent.agentId,providerId:'codex',model:'chosen',effort:'high'})
  expect(result.json).toMatchObject({state:'starting',generation:2,agentId:h.agent.agentId})
  expect(reseat).toHaveBeenCalledWith({agentId:h.agent.agentId,providerId:'codex',model:'chosen',effort:'high'})
  reject(new Error('CLI is missing'))
  await Promise.resolve()
})

it('refuses another subtree without reaching the host replacement method', async () => {
  const h = await setup()
  const reseat = vi.fn()
  Object.assign(h.runtime.host,{reseatAgent:reseat})
  h.runtime.parentOf.set(h.agent.agentId,'other-lead')
  const result = await callTool(h.tools,'reseat_agent',{agentId:h.agent.agentId,providerId:'codex'})
  expect(result.json.error).toBe('unknown_agent')
  expect(reseat).not.toHaveBeenCalled()
})

it('gives old hosts an actionable unsupported response', async () => {
  const h = await setup()
  expect((await callTool(h.tools,'reseat_agent',{agentId:h.agent.agentId})).json.error).toBe('unsupported')
})

it('returns the concrete host refusal without claiming the agent was restarted', async () => {
  const h = await setup()
  Object.assign(h.runtime.host,{reseatAgent:()=>{throw new Error('Wait for its task result')}})
  const result = await callTool(h.tools,'reseat_agent',{agentId:h.agent.agentId})
  expect(result.json).toMatchObject({error:'reseat_failed',message:'Wait for its task result'})
  expect(result.isError).toBe(true)
})

it('blocks replacement when the run budget has already been consumed', async () => {
  const h = await setup()
  const reseat = vi.fn()
  Object.assign(h.runtime.host,{reseatAgent:reseat})
  h.runtime.host.budgetState={usedSec:100,limitSec:60,exhausted:true}
  expect((await callTool(h.tools,'reseat_agent',{agentId:h.agent.agentId})).json.error).toBe('budget_exhausted')
  expect(reseat).not.toHaveBeenCalled()
})

it('exposes and forwards successor provider/model/effort in the root MCP contract', async () => {
  const h = await setup()
  const schema = h.tools.get('request_succession')?.inputSchema
  expect(schema).toHaveProperty('successor')
  const successor={providerId:'codex',model:'chosen',effort:'high'}
  const result = await callTool(h.tools,'request_succession',{reason:'provider_limit',successor})
  expect(result.json.state).toBe('succession_started')
  expect(h.runtime.host.successionCalls.at(-1)).toMatchObject({reason:'provider_limit',successor})
})
