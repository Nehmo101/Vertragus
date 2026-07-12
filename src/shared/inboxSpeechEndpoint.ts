/**
 * Allowlisted OpenAI transcription endpoints — API keys must never be sent elsewhere.
 */
import { DEFAULT_TRANSCRIPTION_ENDPOINT } from './inboxSpeech'

export const ALLOWED_TRANSCRIPTION_HOSTS = new Set(['api.openai.com'])

const REQUIRED_PATH = '/v1/audio/transcriptions'

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '')
}

/** True for localhost, loopback, link-local, and RFC1918-style hosts. */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = stripIpv6Brackets(hostname.trim().toLowerCase())
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '127.0.0.1' || h.startsWith('127.')) return true
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map((part) => Number(part))
    if (octets.some((n) => n > 255)) return true
    const [a, b] = octets
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
  }
  return false
}

/** Validate and normalize a transcription endpoint URL before storing or calling fetch. */
export function validateTranscriptionEndpointUrl(raw: string): string {
  const endpointUrl = raw.trim()
  if (!endpointUrl) throw new Error('Endpunkt-URL darf nicht leer sein.')

  let url: URL
  try {
    url = new URL(endpointUrl)
  } catch {
    throw new Error('Endpunkt-URL ist ungültig.')
  }

  if (url.protocol !== 'https:') {
    throw new Error('Nur HTTPS-Endpunkte sind für Transkription erlaubt.')
  }

  const host = url.hostname.toLowerCase()
  if (isPrivateOrLocalHost(host)) {
    throw new Error('Lokale oder private Endpunkte sind nicht erlaubt.')
  }

  if (!ALLOWED_TRANSCRIPTION_HOSTS.has(host)) {
    throw new Error(`Host "${url.hostname}" ist für Transkription nicht freigegeben.`)
  }

  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (path !== REQUIRED_PATH) {
    throw new Error(`Pfad muss ${REQUIRED_PATH} sein.`)
  }

  if (url.username || url.password) {
    throw new Error('Anmeldedaten in der URL sind nicht erlaubt.')
  }

  return `${url.origin}${REQUIRED_PATH}`
}

export function safeTranscriptionEndpointUrl(raw: string | undefined): string {
  const candidate = raw?.trim() || DEFAULT_TRANSCRIPTION_ENDPOINT
  try {
    return validateTranscriptionEndpointUrl(candidate)
  } catch {
    return DEFAULT_TRANSCRIPTION_ENDPOINT
  }
}
