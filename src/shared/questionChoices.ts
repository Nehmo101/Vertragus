/**
 * Structured labels for agent / user questions, plus a conservative parse
 * fallback so a numbered dump in the question string can still become buttons.
 *
 * Panel and phone both import this helper so the two surfaces cannot drift:
 * structured `choices` win; otherwise a consecutive list of at least two
 * numbered, lettered, or bulleted lines is extracted and the prompt is the
 * text before that list. Unstructured paragraphs are left alone.
 */
import { z } from 'zod'

export const QUESTION_CHOICE_MAX = 28
export const QUESTION_CHOICE_MAX_CHARS = 1_200

/** MCP tool input: trimmed, unique, 1–28 labels, each ≤ 1200 chars. */
export const questionChoicesInputSchema = z
  .array(z.string().trim().min(1).max(QUESTION_CHOICE_MAX_CHARS))
  .min(1)
  .max(QUESTION_CHOICE_MAX)
  .refine((items) => new Set(items).size === items.length, {
    message: 'choices must be unique after trim'
  })

/** Event / handoff / wire field: already-normalized labels. */
export const questionChoicesFieldSchema = z
  .array(z.string().min(1).max(QUESTION_CHOICE_MAX_CHARS))
  .max(QUESTION_CHOICE_MAX)

export interface QuestionChoicesDisplay {
  /** Text shown as the prompt — the list is stripped when it was parsed. */
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
  choices: string[]
): QuestionChoicesDisplay {
  return { prompt: lines.slice(0, start).join('\n').trim(), choices }
}

function takeNumbered(lines: readonly string[], start: number): string[] | undefined {
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
    if (labels.length >= QUESTION_CHOICE_MAX) break
  }
  return uniqueAtLeastTwo(labels)
}

function takeLettered(lines: readonly string[], start: number): string[] | undefined {
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
    if (labels.length >= QUESTION_CHOICE_MAX) break
  }
  return uniqueAtLeastTwo(labels)
}

function takeBullets(lines: readonly string[], start: number): string[] | undefined {
  const labels: string[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') break
    const match = BULLET.exec(line)
    if (!match) break
    const label = capLabel(match[1]!)
    if (!label) break
    labels.push(label)
    if (labels.length >= QUESTION_CHOICE_MAX) break
  }
  return uniqueAtLeastTwo(labels)
}

function capLabel(raw: string): string {
  return raw.trim().slice(0, QUESTION_CHOICE_MAX_CHARS)
}

function uniqueAtLeastTwo(labels: readonly string[]): string[] | undefined {
  const unique = sanitizeQuestionChoices(labels)
  return unique.length >= 2 ? unique : undefined
}
