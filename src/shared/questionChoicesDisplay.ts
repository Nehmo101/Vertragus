/**
 * Structured labels for agent / user questions, plus a conservative parse
 * fallback so a numbered dump in the question string can still become buttons.
 *
 * Panel and phone both import this helper so the two surfaces cannot drift:
 * structured `choices` win; otherwise a consecutive list of at least two
 * numbered, lettered, or bulleted lines is extracted and the prompt is the
 * text before and after that list (the list lines themselves are stripped).
 * Unstructured paragraphs are left alone.
 *
 * This file is deliberately zod-free. The phone client ships it; the MCP
 * schemas live in {@link ./questionChoices.ts} so a value import of one
 * constant cannot pull the validator into the entry chunk.
 */

export const QUESTION_CHOICE_MAX = 28
export const QUESTION_CHOICE_MAX_CHARS = 200

export interface QuestionChoicesDisplay {
  /** Text shown as the prompt — parsed list lines are stripped, surrounding text stays. */
  prompt: string
  /** Button labels; empty means the question stays text-only. */
  choices: string[]
}

/**
 * Trim, drop empties, unique (first wins), cap count and length. Used on the
 * display path so a hostile or leftover wire value cannot mint 200 chips.
 */
export function sanitizeQuestionChoices(
  labels: readonly string[] | undefined | null
): string[] {
  if (!labels || labels.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of labels) {
    const label = raw.trim().slice(0, QUESTION_CHOICE_MAX_CHARS)
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
    if (out.length >= QUESTION_CHOICE_MAX) break
  }
  return out
}

/**
 * Resolve what a human should see: structured choices if present, otherwise a
 * conservative list parse of the question text.
 */
export function questionChoicesDisplay(
  question: string,
  structuredChoices?: readonly string[] | null
): QuestionChoicesDisplay {
  const structured = sanitizeQuestionChoices(structuredChoices)
  if (structured.length > 0) {
    return { prompt: question, choices: structured }
  }
  const parsed = parseChoiceList(question)
  if (parsed) return parsed
  return { prompt: question, choices: [] }
}

const NUMBERED = /^\s*(\d+)[.)]\s+(\S.*)$/
const LETTERED = /^\s*([A-Za-z])[.)]\s+(\S.*)$/
const BULLET = /^\s*[-*+•]\s+(\S.*)$/

interface ParsedRun {
  choices: string[]
  /** Index of the first line after the consecutive list. */
  end: number
}

function parseChoiceList(question: string): QuestionChoicesDisplay | undefined {
  const lines = question.split(/\r?\n/)
  for (let start = 0; start < lines.length; start++) {
    const numbered = takeNumbered(lines, start)
    if (numbered) return displayFrom(lines, start, numbered)
    const lettered = takeLettered(lines, start)
    if (lettered) return displayFrom(lines, start, lettered)
    const bullets = takeBullets(lines, start)
    if (bullets) return displayFrom(lines, start, bullets)
  }
  return undefined
}

function displayFrom(
  lines: readonly string[],
  start: number,
  run: ParsedRun
): QuestionChoicesDisplay {
  return {
    prompt: [...lines.slice(0, start), ...lines.slice(run.end)].join('\n').trim(),
    choices: run.choices
  }
}

function takeNumbered(lines: readonly string[], start: number): ParsedRun | undefined {
  const labels: string[] = []
  let expected = 1
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') break
    const match = NUMBERED.exec(line)
    if (!match) break
    if (Number(match[1]) !== expected) break
    const label = capLabel(match[2]!)
    if (!label) break
    labels.push(label)
    expected += 1
  }
  return parsedRun(labels, start)
}

function takeLettered(lines: readonly string[], start: number): ParsedRun | undefined {
  const first = LETTERED.exec(lines[start] ?? '')
  if (!first) return undefined
  const firstLetter = first[1]!
  const upper = firstLetter === firstLetter.toUpperCase()
  const base = (upper ? 'A' : 'a').charCodeAt(0)
  if (firstLetter.charCodeAt(0) !== base) return undefined
  const labels: string[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') break
    const match = LETTERED.exec(line)
    if (!match) break
    const expected = String.fromCharCode(base + (i - start))
    if (match[1] !== expected) break
    const label = capLabel(match[2]!)
    if (!label) break
    labels.push(label)
  }
  return parsedRun(labels, start)
}

function takeBullets(lines: readonly string[], start: number): ParsedRun | undefined {
  const labels: string[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') break
    const match = BULLET.exec(line)
    if (!match) break
    const label = capLabel(match[1]!)
    if (!label) break
    labels.push(label)
  }
  return parsedRun(labels, start)
}

function parsedRun(labels: readonly string[], start: number): ParsedRun | undefined {
  const unique = uniqueAtLeastTwo(labels)
  if (!unique) return undefined
  return { choices: unique, end: start + labels.length }
}

function capLabel(raw: string): string {
  return raw.trim().slice(0, QUESTION_CHOICE_MAX_CHARS)
}

function uniqueAtLeastTwo(labels: readonly string[]): string[] | undefined {
  const unique = sanitizeQuestionChoices(labels)
  return unique.length >= 2 ? unique : undefined
}
