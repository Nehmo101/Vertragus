import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_MAX_FILES,
  attachmentText,
  clearIdsWhenGoalEmpty,
  clipboardDataLooksLikeImage,
  collectDroppedImages,
  insertAttachmentText,
  isImageFile,
  pasteClipboardImage,
  shouldPreventPasteDefault,
  trackStagingId
} from './imageAttach'

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
    expect(isImageFile({ name: 'notes.pdf', type: 'application/pdf' })).toBe(false)
    expect(isImageFile({ name: 'x.webp', type: 'image/webp' })).toBe(true)
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
  })
})

describe('staging ids', () => {
  it('tracks ids and drops them when the goal is cleared', () => {
    expect(trackStagingId([], 'abc')).toEqual(['abc'])
    expect(trackStagingId(['abc'], undefined)).toEqual(['abc'])
    expect(clearIdsWhenGoalEmpty('   ', ['abc'])).toEqual([])
    expect(clearIdsWhenGoalEmpty('keep', ['abc'])).toEqual(['abc'])
  })
})
