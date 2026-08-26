import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ProfileRow image attach', () => {
  it('pastes and drops into the start-with-goal field and passes staging ids on Play', () => {
    const source = readFileSync(join(__dirname, 'ProfileRow.tsx'), 'utf8')
    expect(source).toContain('onPaste')
    expect(source).toContain('onDrop')
    expect(source).toContain('onDragOver')
    expect(source).toContain('attachmentIds')
    expect(source).toContain('profileId: profile.id')
    expect(source).toContain('replaceIds([])')
    expect(source).toContain('panel.attachImagesHint')
    expect(source).toContain('if (!clipboardDataLooksLikeImage(event.clipboardData)) return')
<<<<<<< HEAD
    const pasteFn = source.slice(source.indexOf('const onGoalPaste'), source.indexOf('const onGoalDrop'))
    expect(pasteFn.indexOf('if (!clipboardDataLooksLikeImage(event.clipboardData)) return')).toBeLessThan(
      pasteFn.indexOf("onSaveAttachment({ profileId: profile.id }, 'clipboard')")
    )
=======
    expect(source).toContain('pasteImageSources(event.clipboardData)')
    expect(source).toContain('applyAttachmentSave')
    expect(source).toContain('ATTACHMENT_MAX_FILES')
    expect(source).not.toContain("onSaveAttachment({ profileId: profile.id }, 'clipboard')")
>>>>>>> 3c7430d (vertragus: Trajano / worker — Changed: src/renderer/src/lib/imageAttach.ts, imageAttach.test.ts; ProfileRow.tsx + ProfileRow.image.test.ts; Workspace…)
  })
})
