/**
 * Who a `user_message` is addressed to — still delivered on the ROOT queue
 * (the orchestrator is the only reader of that feed). Targeting is a hint
 * so the orchestrator can `send_to_agent` the right child, or relay through
 * a root-level parent when the addressee is a helper it cannot address.
 *
 * No peer-to-peer: the host never writes to a nest or lead queue here.
 */

export interface UserMessageTarget {
  targetAgentId: string
  targetName: string
  relayViaAgentId?: string
  relayViaName?: string
}

/**
 * Resolve optional composer targeting. Undefined when the message is for the
 * orchestrator itself (empty id, or the orchestrator's own id).
 */
export function resolveUserMessageTarget(
  targetAgentId: string | undefined,
  lookup: (id: string) => { name: string } | undefined,
  parentOf: (id: string) => string | undefined,
  orchestratorId?: string
): UserMessageTarget | undefined {
  const id = targetAgentId?.trim()
  if (!id || id === orchestratorId) return undefined
  const target = lookup(id)
  if (!target) return undefined
  const parent = parentOf(id)
  if (!parent) {
    return { targetAgentId: id, targetName: target.name }
  }
  let relayId = parent
  let hops = 0
  while (parentOf(relayId) && hops < 8) {
    relayId = parentOf(relayId)!
    hops += 1
  }
  const relay = lookup(relayId)
  return {
    targetAgentId: id,
    targetName: target.name,
    relayViaAgentId: relayId,
    ...(relay ? { relayViaName: relay.name } : {})
  }
}
