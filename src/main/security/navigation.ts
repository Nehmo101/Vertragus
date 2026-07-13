import type { WebContents } from 'electron'

const EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:'])

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false
    if (url.protocol === 'https:') return Boolean(url.hostname)
    return Boolean(url.pathname)
  } catch {
    return false
  }
}

export function isTrustedRendererUrl(
  rawUrl: string,
  developmentUrl?: string,
  packagedRendererUrl?: string
): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'file:') {
      if (!packagedRendererUrl) return false
      return (
        decodeURIComponent(url.pathname) === decodeURIComponent(new URL(packagedRendererUrl).pathname)
      )
    }
    if (!developmentUrl) return false
    return url.origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}

export function protectWebContents(
  webContents: WebContents,
  options: {
    developmentUrl?: string
    packagedRendererUrl?: string
    openExternal: (url: string) => Promise<unknown>
  }
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void options.openExternal(url)
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, options.developmentUrl, options.packagedRendererUrl)) return
    event.preventDefault()
    if (isAllowedExternalUrl(url)) void options.openExternal(url)
  })

  webContents.on('will-attach-webview', (event) => event.preventDefault())
}
