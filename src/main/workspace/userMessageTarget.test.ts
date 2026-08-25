import { describe, expect, it } from 'vitest'
import { resolveUserMessageTarget } from './userMessageTarget'

const names: Record<string, string> = {
  orch: 'Virgilio',
  lead: 'Caronte',
  worker: 'Colombina',
  helper: 'Arsenale'
}

function lookup(id: string): { name: string } | undefined {
  const name = names[id]
  return name ? { name } : undefined
}

function parentOf(id: string): string | undefined {
  if (id === 'helper') return 'worker'
  if (id === 'worker') return 'lead'
  if (id === 'lead') return undefined
  return undefined
}

describe('resolveUserMessageTarget', () => {
  it('omits targeting when the addressee is the orchestrator or empty', () => {
    expect(resolveUserMessageTarget(undefined, lookup, parentOf, 'orch')).toBeUndefined()
    expect(resolveUserMessageTarget('orch', lookup, parentOf, 'orch')).toBeUndefined()
    expect(resolveUserMessageTarget('  ', lookup, parentOf, 'orch')).toBeUndefined()
  })

  it('names a direct child without a relay', () => {
    expect(resolveUserMessageTarget('lead', lookup, parentOf, 'orch')).toEqual({
      targetAgentId: 'lead',
      targetName: 'Caronte'
    })
  })

  it('relays a helper through the root-level ancestor', () => {
    expect(resolveUserMessageTarget('helper', lookup, parentOf, 'orch')).toEqual({
      targetAgentId: 'helper',
      targetName: 'Arsenale',
      relayViaAgentId: 'lead',
      relayViaName: 'Caronte'
    })
  })

  it('ignores an unknown id', () => {
    expect(resolveUserMessageTarget('ghost', lookup, parentOf, 'orch')).toBeUndefined()
  })
})
