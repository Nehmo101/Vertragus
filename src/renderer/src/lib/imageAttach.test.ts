import { describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILES,
  applyAttachmentSave,
  attachmentText,
  clearIdsWhenGoalEmpty,
  clipboardDataLooksLikeImage,
  collectDroppedImages,
  droppedImageSource,
  insertAttachmentText,
  isAllowedImageMime,
  isImageFile,
  pasteClipboardImage,
  pasteImageSources,
  shouldPreventPasteDefault,
  trackStagingId
} from './imageAttach'

function mockFile(init: {
  name: string
  type: string
  size?: number
  path?: string
  arrayBuffer?: () => Promise<ArrayBuffer>
}): File {
  const size = init.size ?? 4
  return {
    name: init.name,
    type: init.type,
    size,
    arrayBuffer: init.arrayBuffer ?? (async () => new ArrayBuffer(size)),
    ...(init.path !== undefined ? { path: init.path } : {})
  } as File
}

describe('attachmentText', () => {
  it('appends one trailing ASCII space and does not quote', () => {
    expect(attachmentText('.vertragus/attachments/screenshot-aa.png')).toBe(
      '.vertragus/attachments/screenshot-aa.png '
    )
    expect(attachmentText('.vertragus/attachments/screenshot-aa.png')).not.toMatch(/['"]/)
  })
})

describe('insertAttachmentText', () => {
  it('inserts at the caret', () => {
    expect(insertAttachmentText('fix ', '.vertragus/attachments/a.png', 4, 4)).toEqual({
      value: 'fix .vertragus/attachments/a.png ',
      caret: 4 + '.vertragus/attachments/a.png '.length
    })
  })
})

describe('isImageFile', () => {
  it('accepts listed types and extensions, skips the rest', () => {
    expect(isImageFile({ name: 'a.PNG', type: '' })).toBe(true)
    expect(isImageFile({ name: 'a.jpg', type: 'image/jpeg' })).toBe(true)
    expect(isImageFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
    expect(isImageFile({ name: 'x.webp', type: 'image/webp' })).toBe(true)
    expect(isImageFile({ name: 'x.tiff', type: 'image/tiff' })).toBe(false)
    expect(isImageFile({ name: 'x.svg', type: 'image/svg+xml' })).toBe(false)
    expect(isImageFile({ name: 'x.bmp', type: 'image/bmp' })).toBe(true)
  })
})

describe('isAllowedImageMime', () => {
  it('allows raster subtypes including x-png, not TIFF/SVG', () => {
    expect(isAllowedImageMime('image/png')).toBe(true)
    expect(isAllowedImageMime('image/x-png')).toBe(true)
    expect(isAllowedImageMime('IMAGE/JPEG')).toBe(true)
    expect(isAllowedImageMime('image/jpg')).toBe(true)
    expect(isAllowedImageMime('image/tiff')).toBe(false)
    expect(isAllowedImageMime('image/svg+xml')).toBe(false)
    expect(isAllowedImageMime('image/heic')).toBe(false)
    expect(isAllowedImageMime('text/plain')).toBe(false)
  })
})

describe('collectDroppedImages', () => {
  it('skips non-images silently and caps at 8', () => {
    const files = [
      { name: 'a.txt', type: 'text/plain' },
      ...Array.from({ length: 10 }, (_, i) => ({ name: `s${i}.png`, type: 'image/png' }))
    ] as unknown as File[]
    const kept = collectDroppedImages(files)
    expect(kept).toHaveLength(ATTACHMENT_MAX_FILES)
    expect(kept.every((file) => file.name.endsWith('.png'))).toBe(true)
  })

  it('skips files over 8MiB before they are read', () => {
    const ok = mockFile({ name: 'ok.png', type: 'image/png', size: 16 })
    const huge = mockFile({
      name: 'huge.png',
      type: 'image/png',
      size: ATTACHMENT_MAX_BYTES + 1
    })
    expect(collectDroppedImages([ok, huge]).map((file) => file.name)).toEqual(['ok.png'])
  })
})

describe('droppedImageSource', () => {
  it('returns absPath when File.path is set and the file is within the cap', async () => {
    expect(
      await droppedImageSource(
        mockFile({ name: 'a.png', type: 'image/png', size: 10, path: 'C:\\shot.png' })
      )
    ).toEqual({ absPath: 'C:\\shot.png' })
  })

  it('falls back to arrayBuffer when File.path is missing', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const file = mockFile({
      name: 'a.png',
      type: 'image/png',
      size: 3,
      arrayBuffer: async () => bytes.buffer
    })
    expect(await droppedImageSource(file)).toEqual({ bytes, mime: 'image/png' })
  })

  it('does not arrayBuffer a file over 8MiB, even when path is unset', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(ATTACHMENT_MAX_BYTES + 1))
    const file = mockFile({
      name: 'big.png',
      type: 'image/png',
      size: ATTACHMENT_MAX_BYTES + 1,
      arrayBuffer
    })
    expect(await droppedImageSource(file)).toBeNull()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('does not send absPath for an oversize file either', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8))
    expect(
      await droppedImageSource(
        mockFile({
          name: 'big.png',
          type: 'image/png',
          size: ATTACHMENT_MAX_BYTES + 1,
          path: 'C:\\big.png',
          arrayBuffer
        })
      )
    ).toBeNull()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
})

describe('clipboardDataLooksLikeImage / preventDefault', () => {
  it('detects image items and does not preventDefault on a null save', () => {
    expect(
      clipboardDataLooksLikeImage({ items: [{ type: 'image/png' }], types: ['image/png'] })
    ).toBe(true)
    expect(clipboardDataLooksLikeImage({ types: ['text/plain'] })).toBe(false)
    expect(shouldPreventPasteDefault(null)).toBe(false)
    expect(shouldPreventPasteDefault({ relativePath: '.vertragus/attachments/a.png' })).toBe(true)
  })

  it('does not treat TIFF/SVG/any image/* as an image paste', () => {
    expect(clipboardDataLooksLikeImage({ types: ['image/tiff'] })).toBe(false)
    expect(clipboardDataLooksLikeImage({ types: ['image/svg+xml'] })).toBe(false)
    expect(clipboardDataLooksLikeImage({ items: [{ type: 'image/tiff' }] })).toBe(false)
    expect(clipboardDataLooksLikeImage({ items: [{ type: 'image/svg+xml' }] })).toBe(false)
    expect(clipboardDataLooksLikeImage({ types: ['image/png'] })).toBe(true)
    expect(clipboardDataLooksLikeImage({ types: ['image/x-png'] })).toBe(true)
  })

  it('paste with only text/plain must not invoke the save callback', () => {
    let saves = 0
    const save = (): void => {
      saves += 1
    }
    expect(pasteClipboardImage({ types: ['text/plain'] }, save)).toBe(false)
    expect(saves).toBe(0)
    expect(pasteClipboardImage({ types: ['text/plain', 'text/html'] }, save)).toBe(false)
    expect(saves).toBe(0)
    expect(pasteClipboardImage({ types: ['image/png'] }, save)).toBe(true)
    expect(saves).toBe(1)
    expect(pasteClipboardImage({ types: ['image/tiff'] }, save)).toBe(false)
    expect(saves).toBe(1)
  })
})

describe('pasteImageSources', () => {
  it('uses native clipboard when the FileList is empty (screenshot)', async () => {
    expect(await pasteImageSources(null)).toEqual(['clipboard'])
    expect(await pasteImageSources({})).toEqual(['clipboard'])
    expect(await pasteImageSources({ files: [] })).toEqual(['clipboard'])
  })

  it('saves clipboard files via absPath/bytes, not clipboard', async () => {
    const file = mockFile({
      name: 'copied.png',
      type: 'image/png',
      size: 8,
      path: '/tmp/copied.png'
    })
    expect(await pasteImageSources({ files: [file] })).toEqual([{ absPath: '/tmp/copied.png' }])
  })

  it('does not fall back to clipboard when the only files are oversize', async () => {
    const huge = mockFile({
      name: 'huge.png',
      type: 'image/png',
      size: ATTACHMENT_MAX_BYTES + 1
    })
    expect(await pasteImageSources({ files: [huge] })).toEqual([])
  })
})

describe('staging ids', () => {
  it('tracks ids and drops them when the goal is cleared', () => {
    expect(trackStagingId([], 'abc')).toEqual(['abc'])
    expect(trackStagingId(['abc'], undefined)).toEqual(['abc'])
    expect(clearIdsWhenGoalEmpty('   ', ['abc'])).toEqual([])
    expect(clearIdsWhenGoalEmpty('keep', ['abc'])).toEqual(['abc'])
  })

  it('never keeps more than ATTACHMENT_MAX_FILES staging ids', () => {
    const full = Array.from({ length: ATTACHMENT_MAX_FILES }, (_, i) => `id${i}`)
    expect(trackStagingId(full, 'extra')).toEqual(full)
    expect(trackStagingId(full.slice(0, 7), 'id7')).toHaveLength(ATTACHMENT_MAX_FILES)
  })

  it('does not promise a 9th path in the goal when the id would be dropped', () => {
    const full = Array.from({ length: ATTACHMENT_MAX_FILES }, (_, i) => `id${i}`)
    expect(
      applyAttachmentSave(full, { relativePath: '.vertragus/attachments/x.png', stagingId: 'extra' })
    ).toBeNull()
    expect(
      applyAttachmentSave(['a'], { relativePath: '.vertragus/attachments/a.png', stagingId: 'b' })
    ).toEqual({
      ids: ['a', 'b'],
      relativePath: '.vertragus/attachments/a.png'
    })
    expect(
      applyAttachmentSave(full, { relativePath: '.vertragus/attachments/live.png' })
    ).toEqual({
      ids: full,
      relativePath: '.vertragus/attachments/live.png'
    })
  })
})
