#!/usr/bin/env node
/**
 * fake-agent — a real MCP client that behaves like a subagent, without a model.
 *
 * The integration test spawns this as a child process with a subagent URL, so
 * the whole loop (HTTP, session, tools, blocking ask, ticket resume, process
 * death) is exercised across a process boundary exactly as it will be in
 * production. It prints machine-readable lines so the test can synchronise on
 * real progress instead of sleeping.
 *
 * Usage:  node scripts/fake-agent.mjs <subagent-url> <mode> [text]
 *
 * Modes:
 *   done                call report_done and exit
 *   done-on-cue         wait for one line on stdin, then report_done (lets a
 *                       test park an await_events waiter BEFORE the push, which
 *                       is what makes the latency measurement deterministic)
 *   ask                 ask a question, print the answer, exit
 *   ask-ticket          ask, expect a timeout + ticket, resume with that ticket
 *   progress-then-done  report_progress, then report_done
 *   die                 exit(1) immediately, saying nothing at all
 *
 * Output lines: READY, TICKET:<id>, ANSWER:<text>, DONE, PROGRESS, ERROR:<text>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [, , url, mode = 'done', text = ''] = process.argv

if (mode === 'die') {
  // No message, no report — the orchestrator must learn about this from the
  // host as agent_exited{confirmed:false}.
  process.exit(1)
}

if (!url) {
  console.error('ERROR:missing subagent url')
  process.exit(2)
}

/** Parse the JSON body of a tool result. */
function payload(result) {
  const body = (result?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  try {
    return JSON.parse(body)
  } catch {
    return { raw: body }
  }
}

function say(line) {
  process.stdout.write(`${line}\n`)
}

/** Resolve on the first complete line arriving on stdin. */
function waitForCue() {
  return new Promise((resolve) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      process.stdin.off('data', onData)
      process.stdin.pause()
      resolve(buffer.slice(0, newline))
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

const client = new Client({ name: 'vertragus-fake-agent', version: '1.0.0' })

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  say('READY')

  if (mode === 'done') {
    await client.callTool({
      name: 'report_done',
      arguments: { summary: text || 'fake agent finished its task' }
    })
    say('DONE')
  } else if (mode === 'done-on-cue') {
    await waitForCue()
    await client.callTool({
      name: 'report_done',
      arguments: { summary: text || 'fake agent finished on cue' }
    })
    say('DONE')
  } else if (mode === 'progress-then-done') {
    await client.callTool({
      name: 'report_progress',
      arguments: { note: text || 'fake agent is half way' }
    })
    say('PROGRESS')
    await client.callTool({
      name: 'report_done',
      arguments: { summary: 'fake agent finished after progress' }
    })
    say('DONE')
  } else if (mode === 'ask') {
    const answer = payload(
      await client.callTool({
        name: 'ask_orchestrator',
        arguments: { question: text || 'which option should I take?' }
      })
    )
    say(`ANSWER:${answer.answer ?? ''}`)
  } else if (mode === 'ask-ticket') {
    const question = text || 'which option should I take?'
    const first = payload(await client.callTool({ name: 'ask_orchestrator', arguments: { question } }))
    if (first.answer !== null && first.answer !== undefined) {
      say(`ERROR:expected a timeout, got an immediate answer ${JSON.stringify(first.answer)}`)
      process.exitCode = 3
    } else {
      say(`TICKET:${first.ticket}`)
      // Deliberately the identical question text — the ticket is what matters.
      const second = payload(
        await client.callTool({
          name: 'ask_orchestrator',
          arguments: { question, ticket: first.ticket }
        })
      )
      say(`ANSWER:${second.answer ?? ''}`)
    }
  } else {
    say(`ERROR:unknown mode ${mode}`)
    process.exitCode = 2
  }
} catch (error) {
  say(`ERROR:${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await client.close().catch(() => undefined)
}
