/**
 * Guard test for the two invariants that live in `useRemote.ts` itself.
 *
 * Everything this hook DECIDES is a pure module with its own tests —
 * `connection.ts` holds the backoff, the liveness rule, the dispatch rule, the
 * queue bound and the deadlines, and every one of them is pinned there. What is
 * left in the hook is wiring, and two pieces of that wiring carry the whole
 * command queue: the order of the two statements in `flushCommandQueue`, and
 * the socket-identity guard at the top of `onmessage`. Both are argued at
 * length in comments; a comment is not a guard, and inverting either leaves the
 * suite green while producing a duplicated command or a silently dropped one.
 *
 * There is no DOM runner in this project, so the hook cannot be rendered.
 * `RemoteTerminal.test.ts` answered the same problem for the same reason by
 * reading its component's source, and this is the same instrument pointed at
 * the same class of rule. Its limits are worth stating: it proves the source
 * still says what the design requires, not that the design is right — the
 * modules next door do that — so every assertion here is paired with a
 * self-check on its own scanning, and each one was inverted in the source and
 * watched to fail before it was kept.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./useRemote.ts', import.meta.url)), 'utf8')

/** The body of a `const <name> = useCallback(` / `= (` declaration. */
function bodyOf(declaration: string, close: string): string {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`self-check: ${declaration} is no longer declared`)
  const end = source.indexOf(close, start)
  if (end < 0) throw new Error(`self-check: ${declaration} no longer ends in ${close}`)
  return source.slice(start + declaration.length, end)
}

describe('a queued command is marked sent before it is written', () => {
  const body = bodyOf('const flushCommandQueue = useCallback(() => {', '\n  }, [sendRaw])')

  it('is reading the flush loop at all', () => {
    // Self-check for both assertions below: the scan has to be pointing at the
    // loop that writes frames before its verdict on that loop means anything.
    expect(body).toContain('for (const parked of pendingCommands.current.values())')
    expect(body).toContain('sendRaw(frame)')
    expect(body).toContain('parked.frame = null')
  })

  it('clears the frame before handing it to the socket, not after', () => {
    // `frame !== null` is the queue's only record of "not sent yet", and it is
    // what a close event consults to decide which promises survive it. Writing
    // first and clearing second leaves a window in which the frame is on the
    // wire and still recorded as queued, and the next `hello` sends it a second
    // time — a duplicated `answer_question` or `workspaces:start`, which are
    // not idempotent.
    expect(body.indexOf('parked.frame = null')).toBeLessThan(body.indexOf('sendRaw(frame)'))
  })

  it('skips what is already on the wire instead of re-sending it', () => {
    // The other half of the same record: the loop runs over EVERY parked
    // command, in-flight ones included, so without this the flush after a
    // reconnect re-sends commands that were only waiting for an answer.
    expect(body).toContain('if (parked.frame === null) continue')
  })
})

describe('a frame from a socket that has been replaced is not dispatched', () => {
  const body = bodyOf('socket.onmessage = (event) => {', '\n    }\n    socket.onclose')

  it('is reading the message handler at all', () => {
    // Self-check: the handler must be the thing that stamps liveness and
    // dispatches, or the ordering assertion below is about nothing.
    expect(body).toContain('dispatchRef.current(')
    expect(body).toContain('lastInboundAt.current = Date.now()')
  })

  it('checks the socket identity before anything else in the handler', () => {
    // `connect()` orphans the previous socket by clearing `socketRef` and then
    // closing it, and a frame already queued on that socket still fires its
    // message event afterwards — closing a WebSocket does not un-queue what has
    // arrived. Everything below this line assumes the frame belongs to the
    // current connection: a stale `hello` re-attaches and flushes the command
    // queue against a socket that is still CONNECTING, so `sendRaw` drops the
    // frames while the promises count as sent and nothing will ever settle
    // them; a stale `data` chunk is appended to a terminal whose own snapshot
    // already carried it; and the liveness stamps credit the new route with the
    // old one's traffic, which is how a dead route keeps looking alive.
    const guard = 'if (socketRef.current !== socket) return'
    expect(body).toContain(guard)
    const statements = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*'))
    expect(statements[0]).toBe(guard)
  })

  it('closes over the socket it was installed on rather than reading the ref', () => {
    /*
     * The guard is only a guard because `socket` is the handler's own capture:
     * it is what makes "am I still the current socket?" a question with two
     * possible answers. The previous version of this test asserted that the
     * body did not contain `socketRef.current !== socketRef.current` — a string
     * nobody would ever write, so it could not fail and did not check its own
     * title. What the title claims is that `socket` is bound ONCE, in the
     * enclosing scope, before the handler exists — so that is what is asserted.
     */
    const binding = /const socket = new WebSocket\(/
    expect(source).toMatch(binding)
    // Bound exactly once: a second binding, or one inside the handler, would
    // mean the name no longer identifies the connection the handler belongs to.
    expect(source.match(/const socket = new WebSocket\(/g)).toHaveLength(1)
    expect(body).not.toMatch(binding)
    // And the guard compares that capture against the ref, not the ref against
    // itself — the vacuous form the original was reaching for.
    expect(body).toContain('socketRef.current !== socket')
  })
})
