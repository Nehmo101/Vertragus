import { describe, expect, it } from 'vitest'
import { buildVoiceInstructions } from './instructions'

describe('buildVoiceInstructions', () => {
  const profiles = [{ name: 'UWE' }, { name: 'Build' }]

  it('is second person German and lists current profiles', () => {
    const prompt = buildVoiceInstructions({
      locale: 'de',
      wakePhrase: 'Bei Fu0',
      profiles
    })
    expect(prompt).toContain('## Role & Persona')
    expect(prompt).toMatch(/^Du bist /m)
    expect(prompt).toContain('Bei Fu0')
    expect(prompt).toContain('UWE')
    expect(prompt).toContain('Build')
    expect(prompt).toContain('start_workspace')
    expect(prompt).toMatch(/danke|stopp|ende|that's all/i)
    expect(prompt).toMatch(/kein Smalltalk/i)
    expect(prompt).toMatch(/NIEMALS so tun/i)
  })

  it('switches the spoken language with locale en', () => {
    const prompt = buildVoiceInstructions({
      locale: 'en',
      wakePhrase: 'Hey Vertragus',
      profiles
    })
    expect(prompt).toMatch(/^You are /m)
    expect(prompt).toContain('Hey Vertragus')
    expect(prompt).toContain('Do not chit-chat')
    expect(prompt).toContain('Configured profiles: UWE, Build.')
  })

  it('says when no profiles exist instead of listing an empty set', () => {
    const prompt = buildVoiceInstructions({ locale: 'de', wakePhrase: 'Vertragus', profiles: [] })
    expect(prompt).toMatch(/keine Profile/i)
  })
})
