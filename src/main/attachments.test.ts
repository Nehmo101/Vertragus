import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATTACHMENT_ERROR,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_RE,
  STAGING_TTL_MS,
  assertImageBytes,
  attachmentRelativePath,
  bytesFromAbsPath,
  bytesFromClipboard,
  coerceBytes,
  createStagingStore,
  generateAttachmentName,
  localizedAttachmentError,
  sniffImage,
  stagingDirFor,
  stemFromHint,
  throwIfAttachment,
  writeAttachment
} from './attachments'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2
])
const BMP = Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

const temps: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sniffImage', () => {
  it('recognizes png jpeg gif webp bmp by magic bytes', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPEG)).toBe('jpg')
    expect(sniffImage(GIF)).toBe('gif')
    expect(sniffImage(WEBP)).toBe('webp')
    expect(sniffImage(BMP)).toBe('bmp')
  })

  it('rejects short or unknown payloads', () => {
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(sniffImage(Uint8Array.from(Buffer.from('not-an-image!!!!')))).toBeNull()
  })
})

describe('names', () => {
  it('builds a posix relative path and a quoting-free filename', () => {
    const name = generateAttachmentName('png', 'screenshot', 'abc123')
    expect(name).toBe('screenshot-abc123.png')
    expect(ATTACHMENT_NAME_RE.test(name)).toBe(true)
    expect(attachmentRelativePath(name)).toBe('.vertragus/attachments/screenshot-abc123.png')
    expect(attachmentRelativePath(name)).not.toContain('\\')
  })

  it('sanitizes drop hints and falls back to screenshot', () => {
    expect(stemFromHint('Photo 1.JPG')).toBe('photo-1')
    expect(stemFromHint('!!!')).toBe('screenshot')
    expect(stemFromHint(undefined)).toBe('screenshot')
  })
})

describe('assertImageBytes', () => {
  it('rejects oversize and non-images', () => {
    expect(() => assertImageBytes(new Uint8Array(ATTACHMENT_MAX_BYTES + 1))).toThrow(
      ATTACHMENT_ERROR.tooLarge
    )
    expect(() => assertImageBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(
      ATTACHMENT_ERROR.notImage
    )
  })
})

describe('clipboard and absPath', () => {
  it('empty nativeImage is a no-op', () => {
    expect(bytesFromClipboard(null)).toBeNull()
    expect(bytesFromClipboard({ isEmpty: () => true, toPNG: () => PNG })).toBeNull()
  })

  it('reads a clipboard PNG', () => {
    const bytes = bytesFromClipboard({ isEmpty: () => false, toPNG: () => PNG })
    expect(bytes).toEqual(PNG)
  })

  it('reads an absolute image file and refuses a missing or relative path', async () => {
    const dir = temp('vertragus-abs-')
    const file = join(dir, 'shot.png')
    writeFileSync(file, PNG)
    expect(await bytesFromAbsPath(file)).toEqual(PNG)
    await expect(bytesFromAbsPath('relative.png')).rejects.toThrow(ATTACHMENT_ERROR.notImage)
    await expect(bytesFromAbsPath(join(dir, 'gone.png'))).rejects.toThrow(ATTACHMENT_ERROR.notImage)
  })

  it('refuses an absPath bigger than 8 MiB without loading it as an image', async () => {
    const dir = temp('vertragus-huge-')
    const file = join(dir, 'huge.bin')
    writeFileSync(file, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1))
    await expect(bytesFromAbsPath(file)).rejects.toThrow(ATTACHMENT_ERROR.tooLarge)
  })
})

describe('writeAttachment', () => {
  it('writes under the worktree, never a sibling of cwd, and gitignores .vertragus', async () => {
    const cwd = temp('vertragus-wt-')
    const result = await writeAttachment(cwd, PNG, { unique: 'aabbcc' })
    expect(result.relativePath).toBe('.vertragus/attachments/screenshot-aabbcc.png')
    expect(readFileSync(join(cwd, '.vertragus', 'attachments', 'screenshot-aabbcc.png'))).toEqual(
      Buffer.from(PNG)
    )
    expect(readFileSync(join(cwd, '.vertragus', '.gitignore'), 'utf8')).toBe('*\n')
    expect(existsSync(join(cwd, 'screenshot-aabbcc.png'))).toBe(false)
  })

  it('hides the file from git status via .vertragus/.gitignore', async () => {
    const cwd = temp('vertragus-git-')
    execFileSync('git', ['init'], { cwd })
    await writeAttachment(cwd, PNG, { unique: 'deadbe' })
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
    expect(status).not.toMatch(/attachments/)
    expect(status).not.toMatch(/screenshot-deadbe/)
  })

  it('refuses a cwd that is not a directory', async () => {
    const dir = temp('vertragus-missing-')
    await expect(writeAttachment(join(dir, 'nope'), PNG)).rejects.toThrow(
      ATTACHMENT_ERROR.worktreeMissing
    )
  })
})

describe('staging store', () => {
  it('stages under userData/attachment-staging, not a repo checkout', async () => {
    const userData = temp('vertragus-ud-')
    const repo = temp('vertragus-repo-')
    const store = createStagingStore({
      dir: stagingDirFor(userData),
      now: () => 1_000,
      unique: (() => {
        let n = 0
        return () => `id${++n}`
      })()
    })
    const saved = await store.save(PNG)
    expect(saved.relativePath).toBe('.vertragus/attachments/screenshot-id1.png')
    expect(saved.stagingId).toBe('id2')
    expect(existsSync(join(userData, 'attachment-staging', 'id2', 'payload'))).toBe(true)
    expect(existsSync(join(repo, '.vertragus'))).toBe(false)
  })

  it('copyTo materializes into the dest worktree then consume drops staging', async () => {
    const userData = temp('vertragus-ud2-')
    const dest = temp('vertragus-dest-')
    const store = createStagingStore({
      dir: stagingDirFor(userData),
      now: () => 1_000,
      unique: (() => {
        let n = 0
        return () => `s${++n}`
      })()
    })
    const saved = await store.save(JPEG, { hint: 'shot.jpg' })
    await store.copyTo([saved.stagingId], dest)
    expect(
      readFileSync(join(dest, ...saved.relativePath.split('/')))
    ).toEqual(Buffer.from(JPEG))
    expect(readFileSync(join(dest, '.vertragus', '.gitignore'), 'utf8')).toBe('*\n')
    await store.consume([saved.stagingId])
    expect(existsSync(join(userData, 'attachment-staging', saved.stagingId))).toBe(false)
  })

  it('expires staging after 60 minutes', async () => {
    const userData = temp('vertragus-ttl-')
    let now = 1_000
    const store = createStagingStore({
      dir: stagingDirFor(userData),
      now: () => now,
      unique: () => 'only'
    })
    const saved = await store.save(PNG)
    now = 1_000 + STAGING_TTL_MS + 1
    const dest = temp('vertragus-ttl-dest-')
    await expect(store.copyTo([saved.stagingId], dest)).rejects.toThrow(
      ATTACHMENT_ERROR.stagingExpired
    )
  })

  it('unknown staging ids fail as expired', async () => {
    const store = createStagingStore({ dir: stagingDirFor(temp('vertragus-gone-')) })
    await expect(store.copyTo(['nope'], temp('vertragus-gone-dest-'))).rejects.toThrow(
      ATTACHMENT_ERROR.stagingExpired
    )
  })
})

describe('localizedAttachmentError', () => {
  it('maps codes through mainMessages', () => {
    expect(localizedAttachmentError(new Error(ATTACHMENT_ERROR.tooLarge), 'en').message).toContain(
      '8 MiB'
    )
    expect(localizedAttachmentError(new Error(ATTACHMENT_ERROR.notImage), 'de').message).toContain(
      'Bild'
    )
    expect(localizedAttachmentError(new Error(ATTACHMENT_ERROR.stagingExpired), 'en').message).toMatch(
      /expired/i
    )
    expect(localizedAttachmentError(new Error(ATTACHMENT_ERROR.worktreeMissing), 'en').message).toMatch(
      /worktree/i
    )
    expect(localizedAttachmentError(new Error('other'), 'en').message).toBe('other')
  })

  it('rethrows attachment codes and leaves other errors alone', () => {
    expect(() => throwIfAttachment(new Error(ATTACHMENT_ERROR.tooLarge), 'en')).toThrow(/8 MiB/)
    expect(() => throwIfAttachment(new Error('nope'), 'en')).not.toThrow()
  })
})

describe('coerceBytes', () => {
  it('accepts Uint8Array, Buffer and ArrayBuffer', () => {
    expect(coerceBytes(PNG)).toEqual(PNG)
    expect(coerceBytes(Buffer.from(PNG))).toEqual(PNG)
    expect(coerceBytes(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength))).toEqual(
      PNG
    )
    expect(coerceBytes('nope')).toBeNull()
  })
})

describe('gitignore mkdir is a no-op on a leftover file', () => {
  it('still writes the attachment when .gitignore already exists', async () => {
    const cwd = temp('vertragus-gi-')
    mkdirSync(join(cwd, '.vertragus'), { recursive: true })
    writeFileSync(join(cwd, '.vertragus', '.gitignore'), '*\n')
    const result = await writeAttachment(cwd, GIF, { unique: 'gif1' })
    expect(result.relativePath).toMatch(/\.gif$/)
  })
})
