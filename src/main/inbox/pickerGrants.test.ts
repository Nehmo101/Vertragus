import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, afterEach } from 'vitest'
import {
  __clearPickerGrantsForTest,
  consumePickerGrant,
  issuePickerGrant
} from './pickerGrants'

describe('pickerGrants', () => {
  const roots: string[] = []

  afterEach(() => {
    __clearPickerGrantsForTest()
  })

  afterEach(async () => {
    await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
    roots.length = 0
  })

  it('issues a single-use grant for a picked file', async () => {
    const dir = join(tmpdir(), `orca-grant-${randomUUID()}`)
    roots.push(dir)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'note.txt')
    await writeFile(file, 'hello')

    const grant = issuePickerGrant(file)
    expect(grant.fileName).toBe('note.txt')
    expect(consumePickerGrant(grant.grantId)).toBe(file)
    expect(() => consumePickerGrant(grant.grantId)).toThrow(/ungültig|abgelaufen/)
  })

  it('rejects unknown grant ids', () => {
    expect(() => consumePickerGrant('missing')).toThrow(/ungültig|abgelaufen/)
  })
})
