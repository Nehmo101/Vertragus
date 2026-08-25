import { describe, expect, it } from 'vitest'
import { orderByParent } from './orderByParent'

describe('orderByParent', () => {
  it('places helpers under their worker, under that worker’s lead', () => {
    const agents = [
      { agentId: 'lead', parent: undefined },
      { agentId: 'root-worker', parent: undefined },
      { agentId: 'helper', parent: 'worker' },
      { agentId: 'worker', parent: 'lead' }
    ]
    const ordered = orderByParent(agents, (agent) => agent.parent).map((agent) => agent.agentId)
    expect(ordered).toEqual(['lead', 'worker', 'helper', 'root-worker'])
  })

  it('keeps orphans at the end instead of dropping them', () => {
    const agents = [
      { agentId: 'a', parent: undefined },
      { agentId: 'ghost-child', parent: 'missing' }
    ]
    expect(orderByParent(agents, (agent) => agent.parent).map((agent) => agent.agentId)).toEqual([
      'a',
      'ghost-child'
    ])
  })
})
