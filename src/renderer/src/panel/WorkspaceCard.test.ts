import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('WorkspaceCard goal visibility', () => {
  it('renders workspaceGoalLine below the head, not inside the expanded body', () => {
    const source = readFileSync(join(__dirname, 'WorkspaceCard.tsx'), 'utf8')
    const afterHead = source.slice(source.indexOf('</header>'))
    const goalMarkup = afterHead.indexOf('{goalLine ?')
    const expandedBody = afterHead.indexOf('{expanded ?')
    expect(goalMarkup).toBeGreaterThan(-1)
    expect(expandedBody).toBeGreaterThan(-1)
    expect(goalMarkup).toBeLessThan(expandedBody)
  })
})
