import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Electron entry wires session chrome. Constructing WorkspaceManager
 * here is heavier than the contract: follow-ups and answers must take the
 * panel host path, never a PTY write. This file reads the source.
 *
 * Self-check: the feed function and the action block must still exist.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

describe('CLI session chrome wiring', () => {
  it('finds the feed and the host-path actions it polices', () => {
    expect(source).toContain('function armTerminalChromeFeed')
    expect(source).toContain('cliChromeForWorkspace')
    expect(source).toContain('registry.setAgentSession')
    expect(source).toContain('setTerminalSessionActions')
    expect(source).toContain('directory.postUserMessage')
    expect(source).toContain('directory.answerQuestion')
  })

  it('routes CLI follow-ups and answers through the panel host paths', () => {
    const start = source.indexOf('setTerminalSessionActions({')
    if (start < 0) throw new Error('self-check: setTerminalSessionActions block is gone')
    const block = source.slice(start, start + 900)
    expect(block).toContain('directory.postUserMessage')
    expect(block).toContain('directory.answerQuestion')
    expect(block).not.toMatch(/pty\.write/)
    expect(block).toContain("userQuestion?.questionId === questionId ? 'user' : agentId")
  })
})
