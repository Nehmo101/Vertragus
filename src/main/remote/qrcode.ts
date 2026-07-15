export async function pairingQrDataUrl(payload: string): Promise<string | undefined> {
  try {
    const qrcode = await import('qrcode')
    return qrcode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
      color: { dark: '#15342f', light: '#fffdf7' }
    })
  } catch {
    // The QR package is optional. The one-time code remains available for manual entry.
    return undefined
  }
}

