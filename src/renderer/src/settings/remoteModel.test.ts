import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import {
  ALL_INTERFACES,
  bindOptionLabel,
  detectedTailscaleAddress,
  isAllInterfaces,
  isMissingTailscaleBind,
  missingTailscaleOption,
  remotePickerOptions,
  selectedBindAddress,
  TAILSCALE_AUTO_BIND,
  TAILSCALE_DOWNLOAD_URL
} from './remoteModel'
import type { BindOption } from '@shared/remote/types'

const t = translator('de')
const en = translator('en')

const tailscale: BindOption = {
  label: 'Tailscale (100.64.10.20)',
  address: '100.64.10.20',
  tailscale: true
}
const lan: BindOption = { label: 'LAN (192.168.1.42)', address: '192.168.1.42', tailscale: false }
const all: BindOption = { label: 'Alle Schnittstellen (0.0.0.0)', address: ALL_INTERFACES, tailscale: false }

describe('remotePickerOptions', () => {
  it('keeps a live Tailscale row as-is', () => {
    expect(remotePickerOptions([tailscale, lan, all])).toEqual([tailscale, lan, all])
  })

  it('inserts a Tailscale placeholder when the tailnet is missing', () => {
    const options = remotePickerOptions([lan, all])
    expect(options[0]).toEqual(missingTailscaleOption())
    expect(options.slice(1)).toEqual([lan, all])
  })
})

describe('selectedBindAddress', () => {
  it('selects the resolved address when it is in the picker', () => {
    expect(
      selectedBindAddress({ address: '192.168.1.42' }, [tailscale, lan, all])
    ).toBe('192.168.1.42')
  })

  it('falls back to the live Tailscale IP for auto-bind', () => {
    expect(
      selectedBindAddress({ tailscaleAddress: '100.64.10.20' }, [tailscale, lan, all])
    ).toBe('100.64.10.20')
  })

  it('sits on the placeholder instead of pretending LAN is selected', () => {
    const options = remotePickerOptions([lan, all])
    expect(selectedBindAddress({}, options)).toBe(TAILSCALE_AUTO_BIND)
    expect(isMissingTailscaleBind(TAILSCALE_AUTO_BIND, options)).toBe(true)
  })
})

describe('detectedTailscaleAddress', () => {
  it('prefers the status field, then a live picker row', () => {
    expect(detectedTailscaleAddress({ tailscaleAddress: '100.64.1.1' }, [tailscale])).toBe(
      '100.64.1.1'
    )
    expect(detectedTailscaleAddress({}, [tailscale, lan])).toBe('100.64.10.20')
    expect(detectedTailscaleAddress({}, [lan, all])).toBeUndefined()
  })
})

describe('bindOptionLabel', () => {
  it('names Tailscale, LAN and all-interfaces in both languages', () => {
    expect(bindOptionLabel(tailscale, t)).toBe('Tailscale (100.64.10.20)')
    expect(bindOptionLabel(lan, t)).toBe('Lokales Netz (192.168.1.42)')
    expect(bindOptionLabel(all, t)).toBe('Alle Schnittstellen (0.0.0.0)')
    expect(bindOptionLabel(missingTailscaleOption(), t)).toBe(
      'Tailscale (empfohlen) — nicht gefunden'
    )
    expect(bindOptionLabel(lan, en)).toBe('Local network (192.168.1.42)')
    expect(bindOptionLabel(missingTailscaleOption(), en)).toBe(
      'Tailscale (recommended) — not found'
    )
    expect(bindOptionLabel(all, en)).toBe('All interfaces (0.0.0.0)')
  })
})

describe('isAllInterfaces', () => {
  it('recognises the escape-hatch bind', () => {
    expect(isAllInterfaces(ALL_INTERFACES)).toBe(true)
    expect(isAllInterfaces('100.64.10.20')).toBe(false)
  })
})

describe('TAILSCALE_DOWNLOAD_URL', () => {
  it('points at the official installer over https', () => {
    expect(TAILSCALE_DOWNLOAD_URL).toBe('https://tailscale.com/download')
  })
})
