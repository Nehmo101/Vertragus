import { isTrustedRendererUrl } from '@main/security/navigation'

export interface RendererIpcWebContentsLike {
  id: number
  isDestroyed(): boolean
  getURL(): string
  mainFrame: unknown
}

export interface RendererIpcEventLike {
  sender: RendererIpcWebContentsLike
  senderFrame: { url?: string } | null
}

export interface RendererIpcAuthorizationOptions {
  developmentUrl?: string
  packagedRendererUrl?: string
  isKnownSender(sender: RendererIpcWebContentsLike): boolean
}

/** Fail closed for unknown windows, subframes, destroyed senders and foreign origins. */
export function assertAuthorizedRendererIpcSender(
  event: RendererIpcEventLike,
  options: RendererIpcAuthorizationOptions,
  deniedMessage = 'Renderer-IPC: Zugriff verweigert (unauthorized).'
): void {
  const sender = event?.sender
  const senderFrame = event?.senderFrame
  if (!sender || !senderFrame) throw new Error(deniedMessage)

  const frameUrl = senderFrame.url || sender.getURL()
  if (
    sender.isDestroyed() ||
    !options.isKnownSender(sender) ||
    senderFrame !== sender.mainFrame ||
    !isTrustedRendererUrl(frameUrl, options.developmentUrl, options.packagedRendererUrl)
  ) {
    throw new Error(deniedMessage)
  }
}
