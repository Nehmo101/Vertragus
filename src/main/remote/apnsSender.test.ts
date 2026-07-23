import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  APNS_HOSTS,
  APNS_JWT_TTL_MS,
  Http2ApnsSender,
  buildApnsJwt,
  buildApnsRequest,
  isApnsTokenGone,
  type ApnsRequestParts,
  type ApnsSendResult,
  type ApnsTransport
} from './apnsSender'

function ecKeyPair(): { p8: string; publicKey: import('node:crypto').KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { p8: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey }
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

class RecordingTransport implements ApnsTransport {
  readonly calls: ApnsRequestParts[] = []
  result: ApnsSendResult = { status: 200 }
  closed = false
  request(parts: ApnsRequestParts): Promise<ApnsSendResult> {
    this.calls.push(parts)
    return Promise.resolve(this.result)
  }
  close(): void { this.closed = true }
}

const TARGET = { environment: 'production' as const, bundleId: 'com.example.MissionControl' }

describe('buildApnsJwt', () => {
  it('produces an ES256 provider token with the expected header and claims', () => {
    const { p8, publicKey } = ecKeyPair()
    const jwt = buildApnsJwt({ teamId: 'TEAM123456', keyId: 'KEY1234567', p8 }, 1_700_000_000)
    const [headerSeg, claimsSeg, signatureSeg] = jwt.split('.')
    expect(headerSeg && claimsSeg && signatureSeg).toBeTruthy()

    expect(decodeSegment(headerSeg!)).toEqual({ alg: 'ES256', kid: 'KEY1234567' })
    expect(decodeSegment(claimsSeg!)).toEqual({ iss: 'TEAM123456', iat: 1_700_000_000 })

    // Signature is present and verifies over `header.claims` with the matching public key.
    const signature = Buffer.from(signatureSeg!, 'base64url')
    expect(signature.byteLength).toBe(64) // P-256 ieee-p1363
    expect(
      verify(null, Buffer.from(`${headerSeg}.${claimsSeg}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
    ).toBe(true)
  })

  it('defaults iat to the current unix second', () => {
    const { p8 } = ecKeyPair()
    const before = Math.floor(Date.now() / 1000)
    const claims = decodeSegment(buildApnsJwt({ teamId: 'T', keyId: 'K', p8 }).split('.')[1]!)
    expect(typeof claims.iat).toBe('number')
    expect(claims.iat as number).toBeGreaterThanOrEqual(before)
  })
})

describe('Http2ApnsSender JWT caching', () => {
  it('reuses one JWT within the ttl window and regenerates after it', async () => {
    const { p8 } = ecKeyPair()
    const transport = new RecordingTransport()
    let now = 1_000_000
    const sender = new Http2ApnsSender({ teamId: 'TEAM123456', keyId: 'KEY1234567', p8 }, transport, () => now)

    await sender.send('a'.repeat(64), { aps: {} }, TARGET)
    now += APNS_JWT_TTL_MS - 1
    await sender.send('b'.repeat(64), { aps: {} }, TARGET)
    const firstAuth = transport.calls[0]!.headers.authorization
    const secondAuth = transport.calls[1]!.headers.authorization
    expect(firstAuth).toBe(secondAuth)
    expect(firstAuth.startsWith('bearer ')).toBe(true)

    now += 2 // now just past the 40-minute window
    await sender.send('c'.repeat(64), { aps: {} }, TARGET)
    expect(transport.calls[2]!.headers.authorization).not.toBe(firstAuth)

    sender.close()
    expect(transport.closed).toBe(true)
  })
})

describe('buildApnsRequest', () => {
  it('targets the production host with the correct path, headers and body', () => {
    const parts = buildApnsRequest(
      'deadbeef'.repeat(8),
      { aps: { alert: { title: 'T', body: 'B' }, sound: 'default' }, url: '/#/live' },
      { environment: 'production', bundleId: 'com.example.MissionControl' },
      'jwt-value'
    )
    expect(parts.authority).toBe('https://api.push.apple.com')
    expect(parts.method).toBe('POST')
    expect(parts.path).toBe(`/3/device/${'deadbeef'.repeat(8)}`)
    expect(parts.headers).toMatchObject({
      authorization: 'bearer jwt-value',
      'apns-topic': 'com.example.MissionControl',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json'
    })
    expect(JSON.parse(parts.body)).toEqual({
      aps: { alert: { title: 'T', body: 'B' }, sound: 'default' }, url: '/#/live'
    })
  })

  it('targets the sandbox host for sandbox tokens', () => {
    const parts = buildApnsRequest('f'.repeat(64), {}, { environment: 'sandbox', bundleId: 'com.example.App' }, 'j')
    expect(parts.authority).toBe(APNS_HOSTS.sandbox)
    expect(parts.authority).toBe('https://api.sandbox.push.apple.com')
  })
})

describe('isApnsTokenGone', () => {
  it('prunes on 410 and on 400 with a terminal reason only', () => {
    expect(isApnsTokenGone({ status: 410 })).toBe(true)
    expect(isApnsTokenGone({ status: 400, reason: 'BadDeviceToken' })).toBe(true)
    expect(isApnsTokenGone({ status: 400, reason: 'Unregistered' })).toBe(true)
    expect(isApnsTokenGone({ status: 400, reason: 'DeviceTokenNotForTopic' })).toBe(true)
    expect(isApnsTokenGone({ status: 400, reason: 'PayloadTooLarge' })).toBe(false)
    expect(isApnsTokenGone({ status: 200 })).toBe(false)
    expect(isApnsTokenGone({ status: 429, reason: 'TooManyRequests' })).toBe(false)
  })
})
