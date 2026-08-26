/**
 * Image attachments for goal/composer paste-drop and in-app CLI paste-drop.
 *
 * Files land under the TARGET AGENT's worktree at `.vertragus/attachments/`,
 * never under `profile.repoPath`. Pre-start paste (Play fold-out, no worktree
 * yet) stages into `userData/attachment-staging` and is copied into the new
 * orchestrator worktree after `createWorktreeFor` and before spawn / assignGoal.
 *
 * The relative posix path (plus a trailing ASCII space) is what the renderer
 * inserts as text. Generated names match `[a-z0-9._-]+` so the TUI never needs
 * quoting. `.vertragus/.gitignore` with `*` hides the files from agent git
 * status.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { mainMessages } from '@shared/mainMessages'

export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
export const ATTACHMENT_MAX_FILES = 8
export const STAGING_TTL_MS = 60 * 60 * 1000
export const ATTACHMENTS_REL_DIR = '.vertragus/attachments'
export const ATTACHMENT_NAME_RE = /^[a-z0-9._-]+$/
export const STAGING_FOLDER = 'attachment-staging'

export const ATTACHMENT_ERROR = {
  tooLarge: 'attachment_too_large',
  notImage: 'attachment_not_image',
  stagingExpired: 'attachment_staging_expired',
  worktreeMissing: 'attachment_worktree_missing'
} as const

export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR)[keyof typeof ATTACHMENT_ERROR]

export type ImageExt = 'png' | 'jpg' | 'gif' | 'webp' | 'bmp'

export interface ClipboardImage {
  isEmpty(): boolean
  toPNG(): Uint8Array | Buffer
}

export interface StagingSaveResult {
  stagingId: string
  relativePath: string
}

export interface LiveSaveResult {
  relativePath: string
}

export interface StagingStore {
  save(bytes: Uint8Array, options?: { hint?: string }): Promise<StagingSaveResult>
  copyTo(ids: readonly string[], destCwd: string): Promise<void>
  consume(ids: readonly string[]): Promise<void>
  sweep(): Promise<void>
}

interface StagingMeta {
  relativePath: string
  createdAt: number
}

function asError(code: AttachmentErrorCode): Error {
  return new Error(code)
}

export function stagingDirFor(userDataPath: string): string {
  return join(userDataPath, STAGING_FOLDER)
}

export function attachmentRelativePath(filename: string): string {
  return `${ATTACHMENTS_REL_DIR}/${filename}`
}

export function sniffImage(bytes: Uint8Array): ImageExt | null {
  if (bytes.length < 12) return null
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif'
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp'
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  return null
}

export function stemFromHint(hint: string | undefined): string {
  if (!hint) return 'screenshot'
  const trimmed = hint.replace(/\.(png|jpe?g|gif|webp|bmp)$/i, '')
  const stem = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return stem || 'screenshot'
}

export function generateAttachmentName(
  ext: ImageExt,
  hint?: string,
  unique = uniqueSuffix()
): string {
  const name = `${stemFromHint(hint)}-${unique}.${ext}`
  if (!ATTACHMENT_NAME_RE.test(name)) return `screenshot-${unique}.${ext}`
  return name
}

function uniqueSuffix(now: () => number = Date.now, entropy: (n: number) => Buffer = randomBytes): string {
  return `${now().toString(36)}${entropy(3).toString('hex')}`
}

export function coerceBytes(value: unknown): Uint8Array | null {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return Uint8Array.from(value)
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

export function assertImageBytes(bytes: Uint8Array): ImageExt {
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw asError(ATTACHMENT_ERROR.tooLarge)
  if (bytes.byteLength === 0) throw asError(ATTACHMENT_ERROR.notImage)
  const ext = sniffImage(bytes)
  if (!ext) throw asError(ATTACHMENT_ERROR.notImage)
  return ext
}

export function bytesFromClipboard(image: ClipboardImage | null | undefined): Uint8Array | null {
  if (!image || image.isEmpty()) return null
  const png = image.toPNG()
  const bytes = coerceBytes(png)
  if (!bytes || bytes.byteLength === 0) return null
  assertImageBytes(bytes)
  return bytes
}

export async function bytesFromAbsPath(absPath: string): Promise<Uint8Array> {
  if (!absPath || !isAbsolute(absPath)) throw asError(ATTACHMENT_ERROR.notImage)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absPath)
  } catch {
    throw asError(ATTACHMENT_ERROR.notImage)
  }
  if (!info.isFile()) throw asError(ATTACHMENT_ERROR.notImage)
  if (info.size > ATTACHMENT_MAX_BYTES) throw asError(ATTACHMENT_ERROR.tooLarge)
  const bytes = coerceBytes(await readFile(absPath))
  if (!bytes) throw asError(ATTACHMENT_ERROR.notImage)
  assertImageBytes(bytes)
  return bytes
}

async function ensureAttachmentGitignore(cwd: string): Promise<void> {
  const dir = join(cwd, '.vertragus')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    }
  )
}

async function assertWorktreeCwd(cwd: string): Promise<void> {
  try {
    const info = await stat(cwd)
    if (!info.isDirectory()) throw asError(ATTACHMENT_ERROR.worktreeMissing)
  } catch (error) {
    if (error instanceof Error && error.message === ATTACHMENT_ERROR.worktreeMissing) throw error
    throw asError(ATTACHMENT_ERROR.worktreeMissing)
  }
}

function filenameFromRelative(relativePath: string): string {
  const prefix = `${ATTACHMENTS_REL_DIR}/`
  if (!relativePath.startsWith(prefix)) throw asError(ATTACHMENT_ERROR.notImage)
  const filename = relativePath.slice(prefix.length)
  if (!ATTACHMENT_NAME_RE.test(filename) || filename.includes('/') || filename.includes('\\')) {
    throw asError(ATTACHMENT_ERROR.notImage)
  }
  return filename
}

export async function writeAttachment(
  cwd: string,
  bytes: Uint8Array,
  options: { hint?: string; filename?: string; unique?: string } = {}
): Promise<LiveSaveResult> {
  await assertWorktreeCwd(cwd)
  const ext = assertImageBytes(bytes)
  const filename = options.filename ?? generateAttachmentName(ext, options.hint, options.unique)
  if (!ATTACHMENT_NAME_RE.test(filename)) throw asError(ATTACHMENT_ERROR.notImage)
  await ensureAttachmentGitignore(cwd)
  const folder = join(cwd, '.vertragus', 'attachments')
  await mkdir(folder, { recursive: true })
  let destName = filename
  if (!options.filename && existsSync(join(folder, destName))) {
    destName = generateAttachmentName(ext, options.hint)
  }
  await writeFile(join(folder, destName), bytes)
  return { relativePath: attachmentRelativePath(destName) }
}

export function localizedAttachmentError(error: unknown, locale: string | undefined): Error {
  const code = error instanceof Error ? error.message : String(error)
  const messages = mainMessages(locale)
  switch (code) {
    case ATTACHMENT_ERROR.tooLarge:
      return new Error(messages.attachmentTooLarge)
    case ATTACHMENT_ERROR.notImage:
      return new Error(messages.attachmentNotImage)
    case ATTACHMENT_ERROR.stagingExpired:
      return new Error(messages.attachmentStagingExpired)
    case ATTACHMENT_ERROR.worktreeMissing:
      return new Error(messages.attachmentWorktreeMissing)
    default:
      return error instanceof Error ? error : new Error(String(error))
  }
}

export function rethrowLocalized(error: unknown, locale: string | undefined): never {
  throw localizedAttachmentError(error, locale)
}

function isAttachmentCode(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error)
  return (Object.values(ATTACHMENT_ERROR) as string[]).includes(code)
}

export function throwIfAttachment(error: unknown, locale: string | undefined): void {
  if (isAttachmentCode(error)) rethrowLocalized(error, locale)
}

export function createStagingStore(options: {
  dir: string
  now?: () => number
  unique?: () => string
}): StagingStore {
  const now = options.now ?? Date.now
  const unique = options.unique ?? (() => uniqueSuffix(now))

  const entryDir = (id: string): string => join(options.dir, id)
  const metaPath = (id: string): string => join(entryDir(id), 'meta.json')
  const payloadPath = (id: string): string => join(entryDir(id), 'payload')

  async function readMeta(id: string): Promise<StagingMeta | undefined> {
    try {
      const raw = JSON.parse(await readFile(metaPath(id), 'utf8')) as StagingMeta
      if (typeof raw.relativePath !== 'string' || typeof raw.createdAt !== 'number') return undefined
      return raw
    } catch {
      return undefined
    }
  }

  async function drop(id: string): Promise<void> {
    await rm(entryDir(id), { recursive: true, force: true })
  }

  async function sweep(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(options.dir)
    } catch {
      return
    }
    const cutoff = now() - STAGING_TTL_MS
    await Promise.all(
      names.map(async (id) => {
        const meta = await readMeta(id)
        if (!meta || meta.createdAt < cutoff) await drop(id)
      })
    )
  }

  return {
    sweep,
    async save(bytes, saveOptions) {
      await sweep()
      const ext = assertImageBytes(bytes)
      const filename = generateAttachmentName(ext, saveOptions?.hint, unique())
      const relativePath = attachmentRelativePath(filename)
      const stagingId = unique()
      await mkdir(entryDir(stagingId), { recursive: true })
      const meta: StagingMeta = { relativePath, createdAt: now() }
      await writeFile(metaPath(stagingId), JSON.stringify(meta))
      await writeFile(payloadPath(stagingId), bytes)
      return { stagingId, relativePath }
    },
    async copyTo(ids, destCwd) {
      await sweep()
      for (const id of ids) {
        const meta = await readMeta(id)
        if (!meta) throw asError(ATTACHMENT_ERROR.stagingExpired)
        if (now() - meta.createdAt > STAGING_TTL_MS) {
          await drop(id)
          throw asError(ATTACHMENT_ERROR.stagingExpired)
        }
        const payload = coerceBytes(await readFile(payloadPath(id)).catch(() => undefined))
        if (!payload) throw asError(ATTACHMENT_ERROR.stagingExpired)
        const filename = filenameFromRelative(meta.relativePath)
        await writeAttachment(destCwd, payload, { filename })
      }
    },
    async consume(ids) {
      await Promise.all(ids.map((id) => drop(id)))
      await sweep()
    }
  }
}
