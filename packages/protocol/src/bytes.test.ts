import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

type Codecs = typeof import('./bytes')

/** The helpers with the built-in methods of Uint8Array, and without them, as on Node.js 24. */
async function variants(): Promise<[string, Codecs][]> {
  const native = await import('./bytes')
  const saved = {
    fromBase64: Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64'),
    fromHex: Object.getOwnPropertyDescriptor(Uint8Array, 'fromHex'),
    toBase64: Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64'),
    toHex: Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex'),
  }
  for (const name of ['fromBase64', 'fromHex'] as const)
    delete (Uint8Array as unknown as Record<string, unknown>)[name]
  for (const name of ['toBase64', 'toHex'] as const)
    delete (Uint8Array.prototype as unknown as Record<string, unknown>)[name]
  vi.resetModules()
  const fallback = await import('./bytes')
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor)
      Object.defineProperty(name.startsWith('to') ? Uint8Array.prototype : Uint8Array, name, descriptor)
  }

  return [['built-in methods', native], ['Node.js 24', fallback]]
}

const cases = await variants()

describe('bytes', () => {
  it.each(cases)('encodes and decodes hex with %s', (_, codecs) => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255])

    expect(codecs.bytesToHex(bytes)).toBe('00017f80feff')
    expect([...codecs.bytesFromHex('00017F80feff')]).toEqual([...bytes])
    expect(() => codecs.bytesFromHex('abc')).toThrow(SyntaxError)
    expect(() => codecs.bytesFromHex('zz')).toThrow(SyntaxError)
  })

  it.each(cases)('encodes and decodes base64 with %s', (_, codecs) => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256)
    const text = codecs.bytesToBase64(bytes)

    expect(text).toBe(Buffer.from(bytes).toString('base64'))
    expect([...codecs.bytesFromBase64(text)]).toEqual([...bytes])
    expect([...codecs.bytesFromBase64('aGk=\n')]).toEqual([104, 105])
    expect([...codecs.bytesFromBase64('aG k=')]).toEqual([104, 105])
  })

  // The rules of Uint8Array.fromBase64 with lastChunkHandling 'strict'.
  it.each(cases)('rejects base64 that is not strict with %s', (_, codecs) => {
    for (const text of ['aGk', 'aGk==', 'aG!=', 'aGl=', 'a-k=', 'aGk=aGk='])
      expect(() => codecs.bytesFromBase64(text), text).toThrow(SyntaxError)
  })
})
