import { describe, expect, it } from 'vitest'

const generatorUrl = new URL('../../../scripts/gen-icons.mjs', import.meta.url).href
const { generateIcons, resolveSafePath, validateIconSize } = await import(generatorUrl)

describe('icon generator security', () => {
  it.each([0, -16, 15, 16.5, 24, 2048, Number.NaN, Number.POSITIVE_INFINITY, '256', null])(
    'rejects invalid icon size %j',
    (size) => {
      expect(() => validateIconSize(size)).toThrow('Unsupported icon size')
    }
  )

  it('rejects duplicate icon sizes before reading or writing files', async () => {
    await expect(generateIcons({ iconSizes: [16, 16] })).rejects.toThrow('must not contain duplicates')
  })

  it('rejects incomplete icon sets before reading or writing files', async () => {
    await expect(generateIcons({ iconSizes: [16, 32, 48] })).rejects.toThrow('must include every required platform size')
  })

  it.each(['../outside.png', 'nested/../../outside.png', '..\\outside.png', '/tmp/outside.png', 'C:\\outside.png', '\0'])(
    'rejects path traversal or absolute path %j',
    (path) => {
      expect(() => resolveSafePath('C:/repo/build', path)).toThrow()
    }
  )

  it('keeps valid generated paths inside their declared directory', () => {
    expect(resolveSafePath('C:/repo/build', 'icons/256x256.png')).toMatch(/build[\\/]icons[\\/]256x256\.png$/)
  })
})
