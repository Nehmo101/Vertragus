import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, afterEach } from 'vitest'
import { MAX_COPY_BYTES, tryCopyArtifactFile } from './files'

describe('inbox file artifacts', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
    roots.length = 0
  })

  async function tempFile(bytes: number): Promise<{ dir: string; file: string }> {
    const dir = join(tmpdir(), `orca-inbox-${randomUUID()}`)
    roots.push(dir)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'sample.txt')
    await writeFile(file, 'x'.repeat(bytes))
    return { dir, file }
  }

  it('copies small files into userData inbox folder', async () => {
    const { dir, file } = await tempFile(32)
    const userData = join(dir, 'userdata')
    const result = await tryCopyArtifactFile(userData, 'idea-1', 'art-1', file)
    expect(result.copied).toBe(true)
    expect(result.storedPath).toBeTruthy()
    const info = await stat(result.storedPath!)
    expect(info.isFile()).toBe(true)
  })

  it('keeps reference only for files above MAX_COPY_BYTES', async () => {
    const { dir, file } = await tempFile(MAX_COPY_BYTES + 1)
    const userData = join(dir, 'userdata')
    const result = await tryCopyArtifactFile(userData, 'idea-2', 'art-2', file)
    expect(result.copied).toBe(false)
    expect(result.storedPath).toBeUndefined()
    expect(result.fileName).toBe('sample.txt')
  })
})
