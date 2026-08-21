import { describe, expect, it } from 'vitest'
import { TASK_NOTE_MAX } from './types'
import { createOrchestratorGoalAssembler } from './orchestratorGoal'

const ESC = String.fromCharCode(27)
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

describe('createOrchestratorGoalAssembler', () => {
  it('commits character-by-character typing on Enter', () => {
    const assembler = createOrchestratorGoalAssembler()
    for (const ch of 'Fix the parser') assembler.push(ch)
    expect(assembler.goalText).toBeUndefined()
    expect(assembler.push('\r')).toBe(true)
    expect(assembler.goalText).toBe('Fix the parser')
  })

  it('commits a whole paste-then-Enter as one chunk', () => {
    const assembler = createOrchestratorGoalAssembler()
    expect(assembler.push(`${PASTE_START}Fix the parser${PASTE_END}\r`)).toBe(true)
    expect(assembler.goalText).toBe('Fix the parser')
  })

  it('strips bracketed-paste wrappers so the paste is the task text', () => {
    const assembler = createOrchestratorGoalAssembler()
    assembler.push(`${PASTE_START}Docs schreiben${PASTE_END}`)
    expect(assembler.push('\n')).toBe(true)
    expect(assembler.goalText).toBe('Docs schreiben')
  })

  it('does not commit CR/LF inside an open bracketed paste', () => {
    const assembler = createOrchestratorGoalAssembler()
    expect(
      assembler.push(`${PASTE_START}Fix the parser\nDefinition of done${PASTE_END}`)
    ).toBe(false)
    expect(assembler.goalText).toBeUndefined()
    expect(assembler.push('\r')).toBe(true)
    expect(assembler.goalText).toBe('Fix the parser')
  })

  it('clears aborted composer text on Ctrl+U and Ctrl+C', () => {
    const assembler = createOrchestratorGoalAssembler()
    assembler.push('junk')
    expect(assembler.push(String.fromCharCode(21))).toBe(false)
    expect(assembler.goalText).toBeUndefined()
    assembler.push('the real task')
    expect(assembler.push('\r')).toBe(true)
    expect(assembler.goalText).toBe('the real task')

    const cancelled = createOrchestratorGoalAssembler()
    cancelled.push('also junk')
    expect(cancelled.push(String.fromCharCode(3))).toBe(false)
    cancelled.push('only this')
    expect(cancelled.push('\n')).toBe(true)
    expect(cancelled.goalText).toBe('only this')
  })

  it('handles backspace (BS and DEL) before submit', () => {
    const assembler = createOrchestratorGoalAssembler()
    assembler.push(`abx${String.fromCharCode(8)}c${String.fromCharCode(127)}d\r`)
    expect(assembler.goalText).toBe('abd')
  })

  it('ignores CSI so arrows do not land in the task', () => {
    const assembler = createOrchestratorGoalAssembler()
    assembler.push(`he${ESC}[A${ESC}[Dllo\r`)
    expect(assembler.goalText).toBe('hello')
  })

  it('holds a split CSI across chunks instead of treating it as text', () => {
    const assembler = createOrchestratorGoalAssembler()
    expect(assembler.push(`${ESC}[200`)).toBe(false)
    expect(assembler.push(`~hello${ESC}[201~\r`)).toBe(true)
    expect(assembler.goalText).toBe('hello')
  })

  it('does not commit a whitespace-only submit', () => {
    const assembler = createOrchestratorGoalAssembler()
    expect(assembler.push('   \r')).toBe(false)
    expect(assembler.goalText).toBeUndefined()
    expect(assembler.push('\n')).toBe(false)
    expect(assembler.push('real task\r')).toBe(true)
    expect(assembler.goalText).toBe('real task')
  })

  it('does not replace the first successful note on a later submit', () => {
    const assembler = createOrchestratorGoalAssembler()
    expect(assembler.push('first assignment\r')).toBe(true)
    expect(assembler.push('also look at X\r')).toBe(false)
    expect(assembler.goalText).toBe('first assignment')
  })

  it('shortens through taskNote and ignores a stray ESC before Enter', () => {
    const assembler = createOrchestratorGoalAssembler()
    const long = 'x'.repeat(TASK_NOTE_MAX + 20)
    assembler.push(`${long}${ESC}`)
    expect(assembler.push('\r')).toBe(true)
    expect(assembler.goalText).toHaveLength(TASK_NOTE_MAX)
    expect(assembler.goalText!.endsWith('…')).toBe(true)
  })
})
