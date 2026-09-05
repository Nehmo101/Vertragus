/**
 * Guard test for the one rule in `App.tsx` that no pure module can hold.
 *
 * A draft is "live" while the field that owns it is on screen, and orphaned
 * once it is not — that is what puts a half-typed message into the unsent-text
 * section instead of losing it. The decision is `liveDraftKeys`, which is
 * tested next door. What is NOT testable there is that `App` feeds it the same
 * condition it renders the composer under: `liveDraftKeys` was once given every
 * workspace id while the composer was drawn only for active ones, so a
 * follow-up typed into a run that then ended counted as live, its field
 * vanished with the card, and the section built to catch exactly that returned
 * nothing.
 *
 * Both ends are one line each, in one file, four hundred lines apart, and the
 * whole suite stays green when they disagree. There is no DOM runner here, so
 * this reads the source — the same instrument `useRemote.test.ts` and
 * `RemoteTerminal.test.ts` point at the same class of rule. Its limit is the
 * usual one: it proves the two lines still name the same condition, not that
 * the condition is the right one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8')

describe('AnswerForm choice buttons', () => {
  it('uses the shared helper, submits a tapped label, and keeps Send disabled on blank custom text', () => {
    expect(source).toContain("from '@shared/questionChoicesDisplay'")
    expect(source).toContain('questionChoicesDisplay')
    expect(source).toContain('className="answer-choice"')
    expect(source).toContain('onClick={() => submit(choice)}')
    expect(source).toContain('disabled={busy || !text.trim()}')
  })
})

describe('a composer draft counts as live exactly while its composer is drawn', () => {
  it('is reading a file that still has both ends', () => {
    // Self-check: every assertion below is a claim about these two lines, and
    // a rename that hid either would otherwise green the whole describe.
    expect(source).toContain('<Composer')
    expect(source).toContain('liveDraftKeys(')
  })

  it('draws the composer under `workspace.active`, and nothing else', () => {
    // The gate, read straight out of the JSX above the element.
    const at = source.indexOf('<Composer')
    const gate = source.slice(source.lastIndexOf('{', at), at)
    expect(gate).toContain('workspace.active ?')
  })

  it('derives the live composer keys from that same condition', () => {
    // `composerWorkspaceIds` IS the `active` filter, extracted so the gate is
    // one thing in one place; `liveDraftKeys` must be given its result and not
    // the full id list. Passing `workspaceIds` here is the exact revert that
    // reintroduces the loss, and it is what this line refuses.
    expect(source).toMatch(/composerWorkspaceIds\(api\.workspaces\)/)
    expect(source).toMatch(/liveDraftKeys\(\s*composerIds\b/)
    expect(source).not.toMatch(/liveDraftKeys\(\s*workspaceIds\b/)
  })
})

function sliceFunction(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`self-check: ${name} is gone`)
  const end = source.indexOf(`function ${nextName}(`, start + 1)
  if (end < 0) throw new Error(`self-check: ${name} has no end before ${nextName}`)
  return source.slice(start, end)
}

describe('Return/Send on composer and answer submits instead of inserting a newline', () => {
  const limited = sliceFunction('LimitedTextarea', 'WorkspaceCard')
  const answer = sliceFunction('AnswerForm', 'Composer')
  const composer = sliceFunction('Composer', 'AgentRow')
  const start = sliceFunction('StartForm', 'LimitedTextarea')
  const goal = sliceFunction('GoalRefillForm', 'AnswerForm')

  it('finds the four fields and the shared textarea it is about to police', () => {
    expect(limited).toContain('enterKeyHint={enterKeyHint}')
    expect(composer).toContain('<LimitedTextarea')
    expect(answer).toContain('<LimitedTextarea')
    expect(start).toContain('<LimitedTextarea')
    expect(goal).toContain('<LimitedTextarea')
  })

  it('covers keydown and beforeinput through the send-key helper', () => {
    expect(limited).toContain('shouldSubmitSendKey')
    expect(limited).toContain('shouldSubmitSendInput')
    expect(limited).toContain('onKeyDown')
    expect(limited).toContain('onBeforeInput')
    expect(limited).toContain("enterKeyHint === 'send'")
    // One Return can dispatch both events; a microtask checkpoint runs
    // between them, so the one-submit lock must outlive the turn.
    // Comments name the method they refuse; a call is `queueMicrotask(`.
    expect(limited).not.toMatch(/queueMicrotask\s*\(/)
    expect(limited).toContain('window.setTimeout')
    // InputEvent has no shiftKey; a sticky true would swallow the iOS Send
    // that arrives as beforeinput after a shifted last keydown.
    expect(limited).toContain('shiftHeld.current = false')
  })

  it('gives send-hinted fields a submit callback and keeps start/goal as enter', () => {
    expect(composer).toContain('enterKeyHint="send"')
    expect(composer).toContain('onSubmit={submit}')
    expect(answer).toContain('enterKeyHint="send"')
    expect(answer).toContain('onSubmit={submit}')
    expect(start).toContain('enterKeyHint="enter"')
    expect(start).not.toContain('onSubmit=')
    expect(goal).toContain('enterKeyHint="enter"')
    expect(goal).not.toContain('onSubmit=')
    expect(composer).not.toMatch(/event\.key === 'Enter' && !event\.shiftKey/)
  })

  it('still sends the same two verbs, not a second command', () => {
    expect(composer).toContain("runCommand('user_message'")
    expect(answer).toContain("runCommand('answer_question'")
    expect(composer).not.toContain("runCommand('answer_question'")
    expect(answer).not.toContain("runCommand('user_message'")
  })

  it('wraps composer and answer in a form whose Send is type=submit', () => {
    expect(composer).toMatch(/<form[\s\S]*className="composer"/)
    expect(composer).toContain('type="submit"')
    expect(answer.trimStart().startsWith('function AnswerForm')).toBe(true)
    expect(answer).toContain('<form')
    expect(answer).toContain('type="submit"')
    expect(answer).toContain('event.preventDefault()')
    expect(composer).toContain('event.preventDefault()')
    expect(answer).toContain('submitLock')
    expect(composer).toContain('submitLock')
  })
})

describe('opening a terminal is a named pending screen', () => {
  it('finds the fallback it is about to police', () => {
    expect(source).toContain('className="terminal-pending"')
    expect(source).toContain('function TerminalPending(')
  })

  it('renders the connecting copy and the agent name, not a blank box', () => {
    expect(source).toContain('copy.terminalConnecting')
    expect(source).toContain('className="terminal-pending-title"')
    expect(source).not.toMatch(/fallback=\{<div className="terminal-pending"[^/]*\/>\}/)
  })
})

describe('start and goal-refill primaries sit in a reveal cluster', () => {
  const start = sliceFunction('StartForm', 'LimitedTextarea')
  const goal = sliceFunction('GoalRefillForm', 'AnswerForm')

  it('finds the two forms it is about to police', () => {
    expect(start).toContain('className="primary"')
    expect(goal).toContain('className="primary"')
  })

  it('wraps those primaries in named action clusters, not a random .primary', () => {
    expect(start).toContain('className="start-actions"')
    expect(goal).toContain('className="goal-actions"')
    expect(start).not.toMatch(/className="primary"[\s\S]*className="start-actions"/)
    expect(goal).not.toMatch(/className="primary"[\s\S]*className="goal-actions"/)
  })
})
