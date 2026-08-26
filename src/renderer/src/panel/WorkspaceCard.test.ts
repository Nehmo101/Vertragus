import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('WorkspaceCard image attach wiring', () => {
  it('pastes and drops on the goal refill and composer, not the answer field', () => {
    const source = readFileSync(join(__dirname, 'WorkspaceCard.tsx'), 'utf8')
    expect(source).toContain('onPaste')
    expect(source).toContain('onDrop')
    expect(source).toContain('onDragOver')
    expect(source).toContain("event.preventDefault()")
    expect(source).toContain('onSaveAttachment')
    const answerBlock = source.slice(source.indexOf('panel-answer-input'))
    const firstTextarea = answerBlock.slice(0, answerBlock.indexOf('/>'))
    expect(firstTextarea).not.toContain('onDrop')
  })
})

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
