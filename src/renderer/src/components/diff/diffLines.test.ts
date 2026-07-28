import { describe, expect, it } from 'vitest'
import { classifyDiffLine, countDiffFiles } from './diffLines'

describe('classifyDiffLine', () => {
  it('classifies additions and deletions', () => {
    expect(classifyDiffLine('+const a = 1')).toBe('add')
    expect(classifyDiffLine('-const a = 1')).toBe('del')
    expect(classifyDiffLine('+')).toBe('add')
    expect(classifyDiffLine('-')).toBe('del')
  })

  it('treats file headers as headers, never as add/del lines', () => {
    expect(classifyDiffLine('diff --git a/src/x.ts b/src/x.ts')).toBe('file')
    expect(classifyDiffLine('--- a/src/x.ts')).toBe('file')
    expect(classifyDiffLine('+++ b/src/x.ts')).toBe('file')
    expect(classifyDiffLine('--- /dev/null')).toBe('file')
    expect(classifyDiffLine('+++ /dev/null')).toBe('file')
  })

  it('classifies hunk headers', () => {
    expect(classifyDiffLine('@@ -1,4 +1,6 @@')).toBe('hunk')
    expect(classifyDiffLine('@@ -1 +1 @@ export function x(): void {')).toBe('hunk')
  })

  it('classifies git metadata lines as meta', () => {
    expect(classifyDiffLine('index 3f9c2a1..b4d0e77 100644')).toBe('meta')
    expect(classifyDiffLine('new file mode 100644')).toBe('meta')
    expect(classifyDiffLine('deleted file mode 100644')).toBe('meta')
    expect(classifyDiffLine('rename from src/a.ts')).toBe('meta')
    expect(classifyDiffLine('rename to src/b.ts')).toBe('meta')
    expect(classifyDiffLine('similarity index 92%')).toBe('meta')
    expect(classifyDiffLine('Binary files a/x.png and b/x.png differ')).toBe('meta')
    expect(classifyDiffLine('\\ No newline at end of file')).toBe('meta')
  })

  it('leaves context and empty lines unstyled', () => {
    expect(classifyDiffLine(' const untouched = true')).toBe('context')
    expect(classifyDiffLine('')).toBe('context')
  })
})

describe('countDiffFiles', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1 @@',
    '+created'
  ].join('\n')

  it('counts diff --git blocks', () => {
    expect(countDiffFiles(diff)).toBe(2)
  })

  it('ignores diff --git occurrences inside changed lines', () => {
    expect(countDiffFiles('+diff --git a/x b/x\n context')).toBe(0)
  })

  it('returns 0 for empty input', () => {
    expect(countDiffFiles('')).toBe(0)
  })
})
