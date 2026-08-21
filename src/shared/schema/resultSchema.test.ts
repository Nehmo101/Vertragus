import { describe, expect, it } from 'vitest'
import {
  assertSupportedResultSchema,
  ResultSchemaError,
  RESULT_MAX_CHARS,
  RESULT_SCHEMA_MAX_CHARS,
  validateResult,
  type ResultSchema
} from './resultSchema'

/** The plan's flagship example: a tester's pass/failures report. */
const testerSchema: ResultSchema = {
  type: 'object',
  required: ['pass', 'failures'],
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'string' } }
  }
}

function problemsOf(schema: unknown): string[] {
  try {
    assertSupportedResultSchema(schema)
  } catch (error) {
    if (error instanceof ResultSchemaError) return error.problems
    throw error
  }
  return []
}

describe('assertSupportedResultSchema — subset boundaries', () => {
  it('accepts the supported subset, nested', () => {
    expect(() => assertSupportedResultSchema(testerSchema)).not.toThrow()
    expect(() =>
      assertSupportedResultSchema({
        type: 'object',
        title: 'Review',
        description: 'reviewer verdict',
        properties: {
          verdict: { type: 'string', enum: ['approve', 'rework'] },
          score: { type: 'integer' },
          detail: {
            type: 'object',
            properties: { kind: { type: 'string', const: 'lint' } },
            additionalProperties: { type: 'number' }
          }
        }
      })
    ).not.toThrow()
  })

  it('rejects oneOf, $ref, format and pattern — naming the offending path', () => {
    for (const keyword of ['oneOf', '$ref', 'format', 'pattern']) {
      const problems = problemsOf({ type: 'object', properties: { x: { type: 'string', [keyword]: 'x' } } })
      expect(problems.some((p) => p.includes(`resultSchema.properties.x.${keyword}`))).toBe(true)
      expect(problems.some((p) => p.includes('unsupported keyword'))).toBe(true)
    }
  })

  it('rejects a non-object root — a result is a named-field report, never a bare scalar', () => {
    expect(problemsOf({ type: 'string' })).toEqual([
      'resultSchema.type: the root must be type "object"'
    ])
    expect(problemsOf({ type: 'array', items: { type: 'string' } })[0]).toContain(
      'root must be type "object"'
    )
  })

  it('rejects non-object schema nodes and missing/unknown types', () => {
    expect(problemsOf('nope')[0]).toContain('resultSchema: a schema must be an object')
    expect(problemsOf({})[0]).toContain('resultSchema.type: must be one of')
    expect(problemsOf({ type: 'object', properties: { x: { type: 'date' } } })[0]).toContain(
      'resultSchema.properties.x.type'
    )
  })

  it('rejects object-only keywords on non-object nodes and items off arrays', () => {
    const problems = problemsOf({
      type: 'object',
      properties: {
        a: { type: 'string', properties: {} },
        b: { type: 'string', items: { type: 'string' } }
      }
    })
    expect(problems.some((p) => p.includes('a.properties: only allowed with type "object"'))).toBe(true)
    expect(problems.some((p) => p.includes('b.items: only allowed with type "array"'))).toBe(true)
  })

  it('rejects malformed required and empty enum', () => {
    const problems = problemsOf({
      type: 'object',
      required: [1],
      properties: { x: { type: 'string', enum: [] } }
    })
    expect(problems.some((p) => p.includes('required: must be an array of strings'))).toBe(true)
    expect(problems.some((p) => p.includes('enum: must be a non-empty array'))).toBe(true)
  })

  it('lists ALL problems in one throw — one fix round, not error peeling', () => {
    const problems = problemsOf({
      type: 'object',
      oneOf: [],
      properties: { x: { type: 'nope', format: 'email' } }
    })
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('validateResult — error paths', () => {
  it('returns [] for a valid nested result', () => {
    expect(validateResult(testerSchema, { pass: true, failures: [] })).toEqual([])
    expect(validateResult(testerSchema, { pass: false, failures: ['login test red'] })).toEqual([])
  })

  it('names missing required properties', () => {
    expect(validateResult(testerSchema, { pass: true })).toEqual([
      'result.failures: missing required property'
    ])
  })

  it('names the exact array index of a wrong item — the plan example path', () => {
    const errors = validateResult(testerSchema, { pass: true, failures: ['ok', 'ok', 7] })
    expect(errors).toEqual(['result.failures[2]: expected string, got number'])
  })

  it('rejects unexpected properties under additionalProperties: false', () => {
    expect(validateResult(testerSchema, { pass: true, failures: [], extra: 1 })).toEqual([
      'result.extra: unexpected property'
    ])
  })

  it('validates extra properties against an additionalProperties schema', () => {
    const schema: ResultSchema = {
      type: 'object',
      properties: {},
      additionalProperties: { type: 'integer' }
    }
    expect(validateResult(schema, { a: 1, b: 2 })).toEqual([])
    expect(validateResult(schema, { a: 'x' })).toEqual(['result.a: expected integer, got string'])
  })

  it('distinguishes integer from number', () => {
    const schema: ResultSchema = { type: 'object', properties: { n: { type: 'integer' } } }
    expect(validateResult(schema, { n: 3 })).toEqual([])
    expect(validateResult(schema, { n: 3.5 })).toEqual(['result.n: expected integer, got number'])
    const loose: ResultSchema = { type: 'object', properties: { n: { type: 'number' } } }
    expect(validateResult(loose, { n: 3.5 })).toEqual([])
  })

  it('enforces enum and const with structural equality', () => {
    const schema: ResultSchema = {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'rework'] },
        kind: { type: 'string', const: 'review' }
      }
    }
    expect(validateResult(schema, { verdict: 'approve', kind: 'review' })).toEqual([])
    expect(validateResult(schema, { verdict: 'maybe', kind: 'nope' })).toEqual([
      'result.verdict: expected one of ["approve","rework"]',
      'result.kind: expected the constant "review"'
    ])
  })

  it('rejects non-objects at the root, arrays and null included', () => {
    expect(validateResult(testerSchema, null)).toEqual(['result: expected object, got null'])
    expect(validateResult(testerSchema, [])).toEqual(['result: expected object, got array'])
    expect(validateResult(testerSchema, 'done')).toEqual(['result: expected object, got string'])
  })

  it('walks deep nesting with full paths', () => {
    const schema: ResultSchema = {
      type: 'object',
      properties: {
        runs: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, flaky: { type: 'boolean' } }
          }
        }
      }
    }
    expect(
      validateResult(schema, { runs: [{ name: 'a' }, { flaky: 'yes' }] })
    ).toEqual([
      'result.runs[1].name: missing required property',
      'result.runs[1].flaky: expected boolean, got string'
    ])
  })
})

describe('constants', () => {
  it('keeps schemas smaller than results', () => {
    expect(RESULT_SCHEMA_MAX_CHARS).toBe(4_000)
    expect(RESULT_MAX_CHARS).toBe(8_000)
  })
})
