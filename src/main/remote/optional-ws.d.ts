declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  import type { Duplex } from 'node:stream'

  export class WebSocket {
    static readonly OPEN: number
    readonly readyState: number
    send(data: string): void
    close(code?: number, reason?: string): void
    terminate(): void
    on(event: 'message', listener: (data: Buffer) => void): this
    on(event: 'close' | 'error', listener: () => void): this
  }

  export class WebSocketServer {
    constructor(options: {
      noServer: true
      maxPayload: number
      handleProtocols?: (protocols: Set<string>) => string | false
    })
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket) => void
    ): void
    close(callback?: () => void): void
  }
}
