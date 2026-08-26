import { describe, expect, it } from 'vitest'
import {
  QUESTION_CHOICE_MAX,
  QUESTION_CHOICE_MAX_CHARS,
  questionChoicesDisplay,
  questionChoicesFieldSchema,
  questionChoicesInputSchema,
  sanitizeQuestionChoices
} from './questionChoices'

describe('questionChoicesInputSchema', () => {
  it('trims, accepts 1–28 unique labels, and rejects duplicates and empties', () => {
    expect(questionChoicesInputSchema.parse(['  Postgres  ', 'SQLite'])).toEqual([
      'Postgres',
      'SQLite'
    ])
    expect(questionChoicesInputSchema.parse(['Yes'])).toEqual(['Yes'])
    expect(() => questionChoicesInputSchema.parse(['a', 'a'])).toThrow(/unique/i)
    expect(() => questionChoicesInputSchema.parse(['a', '  a  '])).toThrow(/unique/i)
    expect(() => questionChoicesInputSchema.parse(['   '])).toThrow()
    expect(() => questionChoicesInputSchema.parse([])).toThrow()
    expect(() =>
      questionChoicesInputSchema.parse(Array.from({ length: QUESTION_CHOICE_MAX + 1 }, (_, i) => `c${i}`))
    ).toThrow()
    expect(() => questionChoicesInputSchema.parse(['x'.repeat(QUESTION_CHOICE_MAX_CHARS + 1)])).toThrow()
  })
})

describe('questionChoicesFieldSchema', () => {
  it('accepts an omitted-or-present already-normalized list', () => {
    expect(questionChoicesFieldSchema.parse(['Postgres', 'SQLite'])).toEqual(['Postgres', 'SQLite'])
    expect(questionChoicesFieldSchema.parse([])).toEqual([])
  })
})

describe('questionChoicesDisplay — structured choices', () => {
  it('uses structured labels and keeps the question as the prompt', () => {
    expect(
      questionChoicesDisplay('Which database should we use?', ['Postgres', 'SQLite'])
    ).toEqual({
      prompt: 'Which database should we use?',
      choices: ['Postgres', 'SQLite']
    })
  })

  it('does not invent buttons when structured choices are absent or empty', () => {
    expect(questionChoicesDisplay('What should the package be called?')).toEqual({
      prompt: 'What should the package be called?',
      choices: []
    })
    expect(questionChoicesDisplay('Open ended?', [])).toEqual({
      prompt: 'Open ended?',
      choices: []
    })
  })

  it('prefers structured choices over a numbered dump in the question', () => {
    const question = 'Pick one:\n1. leftover dump\n2. also leftover'
    expect(questionChoicesDisplay(question, ['Merge', 'Rebase'])).toEqual({
      prompt: question,
      choices: ['Merge', 'Rebase']
    })
  })
})

describe('questionChoicesDisplay — parse fallback', () => {
  it('extracts a consecutive numbered list and uses the text before it as the prompt', () => {
    expect(
      questionChoicesDisplay('Which database?\n\n1. Postgres\n2. SQLite\n3. MySQL')
    ).toEqual({
      prompt: 'Which database?',
      choices: ['Postgres', 'SQLite', 'MySQL']
    })
  })

  it('accepts 1) numbering and a) / A) lettered lists', () => {
    expect(questionChoicesDisplay('Pick:\n1) Merge\n2) Rebase')).toEqual({
      prompt: 'Pick:',
      choices: ['Merge', 'Rebase']
    })
    expect(questionChoicesDisplay('Pick:\na. bcrypt\nb. argon2')).toEqual({
      prompt: 'Pick:',
      choices: ['bcrypt', 'argon2']
    })
    expect(questionChoicesDisplay('Pick:\nA) left\nB) right')).toEqual({
      prompt: 'Pick:',
      choices: ['left', 'right']
    })
  })

  it('accepts consecutive bullets of -, *, + or •', () => {
    expect(questionChoicesDisplay('Hash?\n- bcrypt\n- argon2')).toEqual({
      prompt: 'Hash?',
      choices: ['bcrypt', 'argon2']
    })
    expect(questionChoicesDisplay('Hash?\n* bcrypt\n* argon2')).toEqual({
      prompt: 'Hash?',
      choices: ['bcrypt', 'argon2']
    })
    expect(questionChoicesDisplay('Hash?\n+ bcrypt\n+ argon2')).toEqual({
      prompt: 'Hash?',
      choices: ['bcrypt', 'argon2']
    })
    expect(questionChoicesDisplay('Hash?\n• bcrypt\n• argon2')).toEqual({
      prompt: 'Hash?',
      choices: ['bcrypt', 'argon2']
    })
  })

  it('splits CRLF the same way as LF', () => {
    expect(questionChoicesDisplay('Pick:\r\n1. Yes\r\n2. No')).toEqual({
      prompt: 'Pick:',
      choices: ['Yes', 'No']
    })
  })

  it('does not parse a single item, a list that does not start at 1/a, or a blank-separated run', () => {
    expect(questionChoicesDisplay('Only one:\n1. Postgres')).toEqual({
      prompt: 'Only one:\n1. Postgres',
      choices: []
    })
    expect(questionChoicesDisplay('Later:\n2. Postgres\n3. SQLite')).toEqual({
      prompt: 'Later:\n2. Postgres\n3. SQLite',
      choices: []
    })
    expect(questionChoicesDisplay('Split:\n1. Postgres\n\n2. SQLite')).toEqual({
      prompt: 'Split:\n1. Postgres\n\n2. SQLite',
      choices: []
    })
  })

  it('does not parse unstructured paragraphs that happen to contain numbers', () => {
    const prose =
      'I think we should use 1. postgres because of 2. reasons in this paragraph, and then ship.'
    expect(questionChoicesDisplay(prose)).toEqual({ prompt: prose, choices: [] })
    const wrapped =
      'See RFC 9110. Then consider the two approaches in prose rather than a list.'
    expect(questionChoicesDisplay(wrapped)).toEqual({ prompt: wrapped, choices: [] })
  })

  it('drops trailing text after a parsed list from the prompt', () => {
    expect(
      questionChoicesDisplay('Which?\n1. Merge\n2. Rebase\n\nPlease pick soon.')
    ).toEqual({
      prompt: 'Which?',
      choices: ['Merge', 'Rebase']
    })
  })

  it('dedupes parsed labels and refuses a list that collapses below two', () => {
    expect(questionChoicesDisplay('Pick:\n1. Yes\n2. Yes')).toEqual({
      prompt: 'Pick:\n1. Yes\n2. Yes',
      choices: []
    })
    expect(questionChoicesDisplay('Pick:\n1. Yes\n2. No\n3. Yes')).toEqual({
      prompt: 'Pick:',
      choices: ['Yes', 'No']
    })
  })
})

describe('sanitizeQuestionChoices', () => {
  it('drops blanks, uniques, and caps count', () => {
    expect(sanitizeQuestionChoices(['  a  ', '', 'a', 'b'])).toEqual(['a', 'b'])
    expect(
      sanitizeQuestionChoices(Array.from({ length: 40 }, (_, i) => `c${i}`))
    ).toHaveLength(QUESTION_CHOICE_MAX)
  })
})
