import qrcode from 'qrcode-generator'

// the library encodes Latin-1 only; URLs with umlauts and emoji need UTF-8
qrcode.stringToBytes = (text) => Array.from(new TextEncoder().encode(text))

/** dark modules, [row][column]; throws if the content doesn't fit in a QR code */
export function qrModules(content: string) {
  // level M survives a few burn marks and wood grain
  const code = qrcode(0, 'M')
  code.addData(content)
  code.make()
  const count = code.getModuleCount()
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => code.isDark(row, column)))
}
