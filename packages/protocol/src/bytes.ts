// NOTICE: Uint8Array has fromHex, toHex, fromBase64, and toBase64 in Node.js 25 and later, Chromium 140 and later
// (so Electron), Firefox, and Safari. Node.js 24 does not have them, and the CLI and the build plugins run there. These
// helpers use the built-in methods when they exist, and the same rules otherwise.
// Removal condition: the packages require Node.js 25 or later.

interface Uint8ArrayCodecs {
  fromBase64?: (text: string, options?: { lastChunkHandling?: 'loose' | 'stop-before-partial' | 'strict' }) => Uint8Array
  fromHex?: (text: string) => Uint8Array
}

const codecs = Uint8Array as unknown as Uint8ArrayCodecs
const hasCodecs = typeof codecs.fromHex === 'function' && typeof codecs.fromBase64 === 'function' && typeof (Uint8Array.prototype as { toHex?: unknown }).toHex === 'function'

/**
 * Standard base64 as bytes, with the rules of `Uint8Array.fromBase64(text, { lastChunkHandling: 'strict' })`: ASCII
 * whitespace is skipped, padding is required, and the bits after the last byte must be zero. Throws a `SyntaxError`
 * otherwise.
 */
export function bytesFromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (hasCodecs)
    return codecs.fromBase64!(text, { lastChunkHandling: 'strict' }) as Uint8Array<ArrayBuffer>

  const compact = text.replace(/[\t\n\f\r ]/g, '')
  if (compact.length % 4 !== 0 || !/^[A-Z\d+/]*={0,2}$/i.test(compact))
    throw new SyntaxError('The text is not standard base64 with padding.')

  const binary = atob(compact)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  // atob ignores the bits after the last byte. Encoding again gives the same text only when they are zero.
  if (bytesToBase64(bytes) !== compact)
    throw new SyntaxError('The base64 text has bits after its last byte.')

  return bytes
}

/** Hex as bytes. Throws a `SyntaxError` for an odd length or a character that is not hex. */
export function bytesFromHex(text: string): Uint8Array<ArrayBuffer> {
  if (hasCodecs)
    return codecs.fromHex!(text) as Uint8Array<ArrayBuffer>
  if (text.length % 2 !== 0 || !/^[\da-f]*$/i.test(text))
    throw new SyntaxError('The text is not hex.')

  return Uint8Array.from({ length: text.length / 2 }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16))
}

/** Bytes as standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (hasCodecs)
    return (bytes as Uint8Array & { toBase64: () => string }).toBase64()

  let binary = ''
  // Chunks keep the arguments of String.fromCharCode below the limit of the engine.
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))

  return btoa(binary)
}

/** Bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  if (hasCodecs)
    return (bytes as Uint8Array & { toHex: () => string }).toHex()

  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
