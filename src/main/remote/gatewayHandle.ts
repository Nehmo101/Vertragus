export interface RemoteGatewayHandle {
  port: number
  origin: string
  close(): Promise<void>
  addAllowedHost(hostname: string): void
  dropDevice(deviceId: string): void
}

let handle: RemoteGatewayHandle | null = null

export function getRemoteGatewayHandle(): RemoteGatewayHandle | null {
  return handle
}

export function setRemoteGatewayHandle(next: RemoteGatewayHandle | null): void {
  handle = next
}

