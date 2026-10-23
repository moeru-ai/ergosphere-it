/**
 * Returns the content address of bytes: their SHA-256 as lowercase hex.
 *
 * Objects, file entries, and key IDs use it. It uses WebCrypto and the built-in `Uint8Array.prototype.toHex`.
 */
export async function contentHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toHex()
}
