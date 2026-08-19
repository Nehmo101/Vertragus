/**
 * A QR code as an inline SVG string — zero-dependency at runtime beyond the
 * tiny `qrcode-generator` encoder, and no network (the CSP forbids it anyway).
 *
 * The pairing URL is short enough that error-correction level M and an
 * auto-selected type number always fit; the SVG scales to whatever box the
 * settings section gives it.
 */
import qrcode from 'qrcode-generator'

export function pairingQrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const cells: string[] = []
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) cells.push(`M${col} ${row}h1v1h-1z`)
    }
  }
  // A 1px-per-module viewBox with a quiet-zone margin; `fill` inherits from CSS
  // so the code follows the theme's ink colour.
  const margin = 2
  const size = count + margin * 2
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR">`,
    `<rect width="${size}" height="${size}" fill="var(--qr-bg, #ffffff)"/>`,
    `<path transform="translate(${margin} ${margin})" d="${cells.join('')}" fill="var(--qr-fg, #05130d)"/>`,
    `</svg>`
  ].join('')
}
