import { createPublicKey, verify } from 'node:crypto'
import type { RemoteActor } from '@shared/remote'

export interface CloudflareAccessConfig {
  teamDomain: string
  audience: string
}

interface AccessClaims {
  iss?: unknown
  aud?: unknown
  exp?: unknown
  nbf?: unknown
  email?: unknown
  sub?: unknown
}

interface AccessJwk {
  kid?: string
  kty?: string
  n?: string
  e?: string
  alg?: string
  use?: string
}

type JwksFetcher = (url: string) => Promise<{ keys: AccessJwk[] }>

function decodeSegment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid JWT encoding.')
  return Buffer.from(value, 'base64url')
}

function parseJson<T>(value: Buffer): T {
  return JSON.parse(value.toString('utf8')) as T
}

function audienceMatches(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected))
}

async function defaultFetch(url: string): Promise<{ keys: AccessJwk[] }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`Access JWKS unavailable (${response.status}).`)
  const body = await response.json() as { keys?: unknown }
  if (!Array.isArray(body.keys)) throw new Error('Access JWKS is malformed.')
  return { keys: body.keys as AccessJwk[] }
}

/** Validates signature, issuer, audience and lifetime before trusting Access identity. */
export class CloudflareAccessVerifier {
  private keys: AccessJwk[] = []
  private keysAt = 0

  constructor(
    private readonly config: CloudflareAccessConfig,
    private readonly fetchJwks: JwksFetcher = defaultFetch,
    private readonly now: () => number = Date.now
  ) {
    const teamDomain = config.teamDomain.replace(/\/$/, '')
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain)) {
      throw new Error('UngÃ¼ltige Cloudflare-Access-Team-Domain.')
    }
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(config.audience)) {
      throw new Error('UngÃ¼ltiger Cloudflare-Access-Audience-Tag.')
    }
    this.config = { teamDomain, audience: config.audience }
  }

  private async loadKeys(force = false): Promise<AccessJwk[]> {
    if (!force && this.keys.length > 0 && this.now() - this.keysAt < 60 * 60_000) return this.keys
    const result = await this.fetchJwks(`${this.config.teamDomain}/cdn-cgi/access/certs`)
    this.keys = result.keys.filter((key) =>
      key.kty === 'RSA' && typeof key.kid === 'string' && typeof key.n === 'string' && typeof key.e === 'string'
    )
    this.keysAt = this.now()
    return this.keys
  }

  async verify(assertion: string | undefined): Promise<RemoteActor | undefined> {
    if (!assertion || assertion.length > 16_384) return undefined
    const segments = assertion.split('.')
    if (segments.length !== 3) return undefined
    try {
      const header = parseJson<{ alg?: unknown; kid?: unknown }>(decodeSegment(segments[0]!))
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return undefined
      let key = (await this.loadKeys()).find((candidate) => candidate.kid === header.kid)
      if (!key) key = (await this.loadKeys(true)).find((candidate) => candidate.kid === header.kid)
      if (!key) return undefined
      const publicKey = createPublicKey({
        key: key as unknown as import('node:crypto').JsonWebKey,
        format: 'jwk'
      })
      const signatureValid = verify(
        'RSA-SHA256',
        Buffer.from(`${segments[0]}.${segments[1]}`),
        publicKey,
        decodeSegment(segments[2]!)
      )
      if (!signatureValid) return undefined
      const claims = parseJson<AccessClaims>(decodeSegment(segments[1]!))
      const nowSeconds = Math.floor(this.now() / 1_000)
      if (
        claims.iss !== this.config.teamDomain ||
        !audienceMatches(claims.aud, this.config.audience) ||
        typeof claims.exp !== 'number' || claims.exp < nowSeconds - 30 ||
        (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 30)
      ) return undefined
      const id = typeof claims.email === 'string'
        ? claims.email.trim().toLowerCase()
        : typeof claims.sub === 'string' ? claims.sub.trim() : ''
      if (!id || id.length > 160) return undefined
      return { id, displayName: typeof claims.email === 'string' ? claims.email.trim() : id }
    } catch {
      return undefined
    }
  }
}
