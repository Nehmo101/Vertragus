/**
 * WebSocket that can send Authorization on the handshake.
 *
 * WHATWG `WebSocket` (the global) takes subprotocols as its second argument,
 * not headers. xAI realtime authenticates with `Authorization: Bearer …` on
 * the upgrade, so production cannot pass `globalThis.WebSocket` straight into
 * `createXaiClient`. This client speaks text frames over `https` upgrade and
 * matches the injected constructor in `voice/xai.ts`.
 *
 * Never log `options.headers` — that object holds the API key.
 */
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import type { InjectedWebSocket } from './voice/xai'

type WsListener = (event: {
  data?: unknown
  code?: number
  reason?: string
  message?: string
}) => void

export class HeaderWebSocket implements InjectedWebSocket {
  readyState = 0
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null

  private socket: Socket | undefined
  private leftover: Buffer = Buffer.alloc(0)
  private readonly listeners = new Map<string, WsListener[]>()

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    const parsed = new URL(url)
    const key = randomBytes(16).toString('base64')
    const isTls = parsed.protocol === 'wss:' || parsed.protocol === 'https:'
    const request = isTls ? httpsRequest : httpRequest
    const req = request({
      protocol: isTls ? 'https:' : 'http:',
      hostname: parsed.hostname,
      port: Number(parsed.port) || (isTls ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Host: parsed.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(options?.headers ?? {})
      }
    })
    req.on('upgrade', (res, socket) => {
      if (!acceptsKey(res, key)) {
        socket.destroy()
        this.fail('websocket handshake rejected')
        return
      }
      this.socket = socket
      this.readyState = 1
      socket.on('data', (chunk: Buffer | string) => this.onBytes(Buffer.from(chunk)))
      socket.on('error', (error) => this.fail(error.message))
      socket.on('close', () => this.closed(1006, ''))
      this.emit('open', {})
      this.onopen?.({})
    })
    req.on('error', (error) => this.fail(error.message))
    req.end()
  }

  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: WsListener
  ): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    if (!this.socket || this.readyState !== 1) return
    this.socket.write(encodeFrame(0x1, Buffer.from(data, 'utf8')))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 2 || this.readyState === 3) return
    this.readyState = 2
    const reasonBuf = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    try {
      this.socket?.write(encodeFrame(0x8, payload))
    } catch {
      /* already gone */
    }
    this.socket?.end()
    this.closed(code, reason)
  }

  private onBytes(chunk: Buffer): void {
    this.leftover = Buffer.from(Buffer.concat([this.leftover, chunk]))
    while (this.leftover.length >= 2) {
      const frame = decodeFrame(this.leftover)
      if (!frame) return
      this.leftover = Buffer.from(frame.rest)
      if (frame.opcode === 0x1) {
        const data = frame.payload.toString('utf8')
        this.emit('message', { data })
        this.onmessage?.({ data })
      } else if (frame.opcode === 0x8) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : ''
        this.closed(code, reason)
      } else if (frame.opcode === 0x9) {
        try {
          this.socket?.write(encodeFrame(0xa, frame.payload))
        } catch {
          /* already gone */
        }
      }
    }
  }

  private fail(message: string): void {
    this.emit('error', { message })
    this.onerror?.({ message })
    this.closed(1006, message)
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.destroy()
    } catch {
      /* already gone */
    }
    this.emit('close', { code, reason })
    this.onclose?.({ code, reason })
  }

  private emit(type: string, event: { data?: unknown; code?: number; reason?: string; message?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function acceptsKey(res: IncomingMessage, key: string): boolean {
  const expected = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  return res.headers['sec-websocket-accept'] === expected
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i]! ^ mask[i % 4]!
  }
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | payload.length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

function decodeFrame(
  buf: Buffer
): { opcode: number; payload: Buffer; rest: Buffer } | undefined {
  if (buf.length < 2) return undefined
  const opcode = buf[0]! & 0x0f
  const masked = (buf[1]! & 0x80) !== 0
  let length = buf[1]! & 0x7f
  let offset = 2
  if (length === 126) {
    if (buf.length < 4) return undefined
    length = buf.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buf.length < 10) return undefined
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    length = Number(big)
    offset = 10
  }
  const maskLen = masked ? 4 : 0
  if (buf.length < offset + maskLen + length) return undefined
  const mask = masked ? buf.subarray(offset, offset + 4) : undefined
  offset += maskLen
  const raw = buf.subarray(offset, offset + length)
  const payload = Buffer.alloc(raw.length)
  if (mask) {
    for (let i = 0; i < raw.length; i += 1) payload[i] = raw[i]! ^ mask[i % 4]!
  } else {
    raw.copy(payload)
  }
  return { opcode, payload: Buffer.from(payload), rest: Buffer.from(buf.subarray(offset + length)) }
}
