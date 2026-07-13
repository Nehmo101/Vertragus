/** Never render PTY output in a pane that does not own the agent instance. */
export function isAgentTerminalChunk(agentId: string, chunkId: string): boolean {
  return chunkId === agentId
}
