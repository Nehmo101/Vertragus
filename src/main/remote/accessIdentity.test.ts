import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CloudflareAccessVerifier } from './accessIdentity'

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('CloudflareAccessVerifier', () => {
  it('trusts identity only after RS256, issuer, audience and expiry validation', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicJwk = pair.publicKey.export({ format: 'jwk' })
    const kid = 'access-key'
    const fetcher = vi.fn(async () => ({ keys: [{ ...publicJwk, kid, alg: 'RS256' }] }))
    const now = 2_000_000_000_000
    const verifier = new CloudflareAccessVerifier({
      teamDomain: 'https://orca.cloudflareaccess.com',
      audience: 'audience_tag_123456789'
    }, fetcher, () => now)
    const header = encode({ alg: 'RS256', kid })
    const claims = encode({
      iss: 'https://orca.cloudflareaccess.com', aud: ['audience_tag_123456789'],
      email: 'Team@Example.com', exp: Math.floor(now / 1_000) + 60
    })
    const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' })
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privatePem)
      .toString('base64url')
    await expect(verifier.verify(`${header}.${claims}.${signature}`)).resolves.toEqual({
      id: 'team@example.com', displayName: 'Team@Example.com'
    })
    await expect(verifier.verify(`${header}.${claims}.${signature.slice(0, -2)}xx`)).resolves.toBeUndefined()
  })
})
