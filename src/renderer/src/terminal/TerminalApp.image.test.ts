import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TerminalApp image paste/drop', () => {
  it('saves via terminal:image and types the path through terminal:input, never as bytes', () => {
    const source = readFileSync(join(__dirname, 'TerminalApp.tsx'), 'utf8')
    expect(source).toContain("bridge.image('clipboard')")
    expect(source).toContain('bridge.image(source)')
    expect(source).toContain('bridge.input(attachmentText(relativePath))')
    expect(source).toContain("addEventListener('paste', onPaste, true)")
    expect(source).toContain("addEventListener('dragover'")
    expect(source).toContain("addEventListener('drop'")
    expect(source).toContain('event.preventDefault()')
    expect(source).not.toMatch(/pty\.write\([^)]*bytes/)
    expect(source).not.toMatch(/bridge\.input\([^)]*Uint8Array/)
  })
})
