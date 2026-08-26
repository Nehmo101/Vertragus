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
    expect(source).toContain('if (!clipboardDataLooksLikeImage(event.clipboardData)) return')
    expect(source.split('if (!clipboardDataLooksLikeImage(event.clipboardData)) return')).toHaveLength(3)
    expect(source).toContain('pasteImageSources(event.clipboardData)')
    expect(source.split('pasteImageSources(event.clipboardData)')).toHaveLength(3)
    expect(source).not.toContain("onSaveAttachment({ workspaceId }, 'clipboard')")
    expect(source).not.toContain("onSaveAttachment(attachTarget, 'clipboard')")
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

  it('offers a timeline control next to the run-folder button', () => {
    const source = readFileSync(join(__dirname, 'WorkspaceCard.tsx'), 'utf8')
    expect(source).toContain('panel.timelineToggle')
    expect(source).toContain('<ClockIcon')
    expect(source).toContain('<RunTimeline')
  })
})

describe('WorkspaceCard question choices', () => {
  const source = readFileSync(join(__dirname, 'WorkspaceCard.tsx'), 'utf8')

  it('resolves buttons through the shared helper and still keeps a custom Send', () => {
    expect(source).toContain('questionChoicesDisplay')
    expect(source).toContain('className="panel-answer-choice"')
    expect(source).toContain('onSubmit(choice)')
    expect(source).toContain('className="panel-answer-send"')
    expect(source).toContain('disabled={!answer.trim()}')
  })
})
