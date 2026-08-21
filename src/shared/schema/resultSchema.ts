/**
 * S3 — the JSON-Schema SUBSET behind `start_agent{resultSchema}`.
 *
 * Hand-rolled on purpose, no ajv: the whole point of structured reports is a
 * schema small enough that a worker model can satisfy it from the contract
 * text alone, so the vocabulary is deliberately tiny — `type` (object, string,
 * number, integer, boolean, array, null), `properties`, `required`, `items`,
 * `enum`, `const`, `additionalProperties`, plus `description`/`title` prose.
 * Everything else (`oneOf`, `$ref`, `format`, `pattern`, …) is REJECTED with
 * the offending path named, never silently ignored — a keyword that does not
 * validate would otherwise teach orchestrators that their constraints hold
 * when they do not. The root must be `type: "object"` so every result is a
 * named-field report, not a bare scalar.
 *
 * Pure module, no I/O, no deps beyond the language — shared between the
 * orchestrator tool (schema vetting) and the subagent tool (result vetting).
 */

/** Serialized-size cap for a schema handed to `start_agent`. */
export const RESULT_SCHEMA_MAX_CHARS = 4_000
/** Serialized-size cap for a `result` handed to `report_done`. */
export const RESULT_MAX_CHARS = 8_000

export const RESULT_SCHEMA_TYPES = [
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'null'
] as const
export type ResultSchemaType = (typeof RESULT_SCHEMA_TYPES)[number]

/** One node of the supported subset. `type` is mandatory at every node. */
export interface ResultSchema {
  type: ResultSchemaType
  properties?: Record<string, ResultSchema>
  required?: string[]
  items?: ResultSchema
  enum?: unknown[]
  const?: unknown
  additionalProperties?: boolean | ResultSchema
  description?: string
  title?: string
}

const KNOWN_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'additionalProperties',
  'description',
  'title'
])

/** Thrown by {@link assertSupportedResultSchema}; carries the full problem list. */
export class ResultSchemaError extends Error {
  constructor(readonly problems: string[]) {
    super(`Unsupported result schema:\n${problems.join('\n')}`)
    this.name = 'ResultSchemaError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collect every subset violation in one pass — fail-loud lists, not first-error. */
function collectSchemaProblems(node: unknown, path: string, problems: string[]): void {
  if (!isPlainObject(node)) {
    problems.push(`${path}: a schema must be an object, got ${describe(node)}`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      problems.push(`${path}.${key}: unsupported keyword — allowed: ${[...KNOWN_KEYWORDS].join(', ')}`)
    }
  }
  const type = node.type
  if (typeof type !== 'string' || !(RESULT_SCHEMA_TYPES as readonly string[]).includes(type)) {
    problems.push(`${path}.type: must be one of ${RESULT_SCHEMA_TYPES.join(', ')}`)
  }
  for (const key of ['description', 'title'] as const) {
    if (node[key] !== undefined && typeof node[key] !== 'string') {
      problems.push(`${path}.${key}: must be a string`)
    }
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    problems.push(`${path}.enum: must be a non-empty array`)
  }
  // Object-only keywords on a non-object type would validate nothing — reject.
  for (const key of ['properties', 'required', 'additionalProperties'] as const) {
    if (node[key] !== undefined && type !== 'object') {
      problems.push(`${path}.${key}: only allowed with type "object"`)
    }
  }
  if (node.items !== undefined && type !== 'array') {
    problems.push(`${path}.items: only allowed with type "array"`)
  }
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      problems.push(`${path}.properties: must be an object of schemas`)
    } else if (type === 'object') {
      for (const [name, child] of Object.entries(node.properties)) {
        collectSchemaProblems(child, `${path}.properties.${name}`, problems)
      }
    }
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
      problems.push(`${path}.required: must be an array of strings`)
    }
  }
  if (node.items !== undefined && type === 'array') {
    collectSchemaProblems(node.items, `${path}.items`, problems)
  }
  if (
    node.additionalProperties !== undefined &&
    typeof node.additionalProperties !== 'boolean' &&
    type === 'object'
  ) {
    collectSchemaProblems(node.additionalProperties, `${path}.additionalProperties`, problems)
  }
}

/**
 * Vet a schema against the subset. Throws a {@link ResultSchemaError} listing
 * EVERY problem with its path — the orchestrator fixes the schema in one round
 * instead of peeling errors one call at a time.
 */
export function assertSupportedResultSchema(schema: unknown): asserts schema is ResultSchema {
  const problems: string[] = []
  collectSchemaProblems(schema, 'resultSchema', problems)
  if (
    problems.length === 0 &&
    isPlainObject(schema) &&
    (schema as { type?: unknown }).type !== 'object'
  ) {
    problems.push('resultSchema.type: the root must be type "object"')
  }
  if (problems.length > 0) throw new ResultSchemaError(problems)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Structural equality over JSON values — what `const` and `enum` compare with. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]))
    )
  }
  return false
}

function matchesType(type: ResultSchemaType, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
  }
}

function validateNode(schema: ResultSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: expected the constant ${JSON.stringify(schema.const)}`)
    return
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(value, entry))) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`)
    return
  }
  if (!matchesType(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}, got ${describe(value)}`)
    return
  }
  if (schema.type === 'object' && isPlainObject(value)) {
    const properties = schema.properties ?? {}
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push(`${path}.${name}: missing required property`)
    }
    for (const [name, entry] of Object.entries(value)) {
      const child = properties[name]
      if (child) {
        validateNode(child, entry, `${path}.${name}`, errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${name}: unexpected property`)
      } else if (typeof schema.additionalProperties === 'object') {
        validateNode(schema.additionalProperties, entry, `${path}.${name}`, errors)
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => validateNode(schema.items!, entry, `${path}[${index}]`, errors))
  }
}

/**
 * Validate a reported result against a vetted schema. Returns error paths in
 * the shape the retrying agent needs (`result.failures[2]: expected string`);
 * an empty list means the result is valid.
 */
export function validateResult(schema: ResultSchema, value: unknown): string[] {
  const errors: string[] = []
  validateNode(schema, value, 'result', errors)
  return errors
}
