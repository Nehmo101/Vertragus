/**
 * Renderer-side image paste/drop: collect files, insert the relative posix
 * path plus one trailing ASCII space, and decide preventDefault.
 *
 * Saving (bytes, clipboard, absPath) is main-process IPC. This module never
 * touches a worktree path.
 */
export const ATTACHMENT_MAX_FILES = 8
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
export const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i
const IMAGE_SUBTYPES = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'x-png'])

export type AttachmentSaveResult = { relativePath: string; stagingId?: string }

export type AttachmentSource =
  | 'clipboard'
  | { absPath: string }
  | { bytes: Uint8Array; mime: string }

export function attachmentText(relativePath: string): string {
  return `${relativePath} `
}

export function insertAttachmentText(
  value: string,
  relativePath: string,
  start: number,
  end: number
): { value: string; caret: number } {
  const text = attachmentText(relativePath)
  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + text.length
  }
}

/** Only the raster types we can sniff in main — not TIFF, SVG, or `image/*`. */
export function isAllowedImageMime(type: string): boolean {
  const lower = type.toLowerCase()
  if (!lower.startsWith('image/')) return false
  return IMAGE_SUBTYPES.has(lower.slice('image/'.length))
}

export function isImageFile(file: { name: string; type: string }): boolean {
  if (file.type && isAllowedImageMime(file.type)) return true
  return IMAGE_NAME.test(file.name)
}

function exceedsAttachmentMax(file: { size?: number }): boolean {
  return typeof file.size === 'number' && file.size > ATTACHMENT_MAX_BYTES
}

export function clipboardDataLooksLikeImage(data: {
  types?: ArrayLike<string>
  files?: ArrayLike<{ name: string; type: string }>
  items?: ArrayLike<{ type: string }>
} | null): boolean {
  if (!data) return false
  if (data.types && Array.from(data.types).some(isAllowedImageMime)) return true
  if (data.items && Array.from(data.items).some((item) => isAllowedImageMime(item.type))) {
    return true
  }
  if (data.files && Array.from(data.files).some(isImageFile)) return true
  return false
}

/** Empty clipboard/nativeImage: caller must NOT preventDefault. */
export function shouldPreventPasteDefault(result: AttachmentSaveResult | null): boolean {
  return result !== null
}

/**
 * Paste-event gate used by goal/composer/CLI. Text-only Ctrl+V must not call
 * save('clipboard') — Windows often still holds a previous screenshot.
 * Returns whether save ran.
 */
export function pasteClipboardImage(
  data: Parameters<typeof clipboardDataLooksLikeImage>[0],
  save: () => void
): boolean {
  if (!clipboardDataLooksLikeImage(data)) return false
  save()
  return true
}

export type DroppedImageSource = { absPath: string } | { bytes: Uint8Array; mime: string }

export function electronFilePath(file: File): string | undefined {
  const path = (file as File & { path?: unknown }).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

export function collectDroppedImages(files: ArrayLike<File>): File[] {
  return Array.from(files)
    .filter(isImageFile)
    .filter((file) => !exceedsAttachmentMax(file))
    .slice(0, ATTACHMENT_MAX_FILES)
}

/**
 * Prefer File.path when Electron still fills it. Otherwise send bytes — but
 * never arrayBuffer a file over ATTACHMENT_MAX_BYTES (main still enforces).
 */
export async function droppedImageSource(file: File): Promise<DroppedImageSource | null> {
  if (exceedsAttachmentMax(file)) return null
  const absPath = electronFilePath(file)
  if (absPath) return { absPath }
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { bytes, mime: file.type || 'application/octet-stream' }
}

export async function droppedImageSources(files: ArrayLike<File>): Promise<DroppedImageSource[]> {
  const out: DroppedImageSource[] = []
  for (const file of collectDroppedImages(files)) {
    const source = await droppedImageSource(file)
    if (source) out.push(source)
  }
  return out
}

/**
 * File paste (Explorer/Finder copy) uses the DataTransfer files, same as drop.
 * Screenshots have an empty FileList — those still go through native clipboard.
 * A FileList that is present but unusable (oversize, non-image) does not fall
 * back to clipboard, so a leftover screenshot is not stolen.
 */
export async function pasteImageSources(
  data: { files?: ArrayLike<File> } | null
): Promise<AttachmentSource[]> {
  const listed = data?.files && data.files.length > 0 ? Array.from(data.files) : []
  if (listed.length > 0) return droppedImageSources(listed)
  return ['clipboard']
}

export function trackStagingId(
  ids: readonly string[],
  stagingId: string | undefined
): string[] {
  if (!stagingId) return [...ids]
  if (ids.length >= ATTACHMENT_MAX_FILES) return [...ids]
  return [...ids, stagingId]
}

/**
 * Cap staging ids at ATTACHMENT_MAX_FILES. Returning null means the path must
 * not be inserted — parseAttachmentIds would drop the extra id on start.
 */
export function applyAttachmentSave(
  ids: readonly string[],
  result: AttachmentSaveResult
): { ids: string[]; relativePath: string } | null {
  if (result.stagingId && ids.length >= ATTACHMENT_MAX_FILES) return null
  return { ids: trackStagingId(ids, result.stagingId), relativePath: result.relativePath }
}

export function clearIdsWhenGoalEmpty(goal: string, ids: readonly string[]): string[] {
  return goal.trim() ? [...ids] : []
}
