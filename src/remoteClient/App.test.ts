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
