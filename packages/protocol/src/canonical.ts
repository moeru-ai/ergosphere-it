/**
 * Serializes a value as canonical JSON: keys sorted by code point at every level and no insignificant whitespace.
 *
 * Signed documents use this form, so one document has exactly one byte sequence.
 *
 * Object properties with `undefined` values are left out, as `JSON.stringify` does. Other `undefined` values,
 * functions, symbols, bigints, and non-finite numbers throw, because JSON cannot carry them losslessly.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)

  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`canonicalJson: non-finite number ${value}`)

    return JSON.stringify(value)
  }

  if (Array.isArray(value))
    return `[${value.map(item => canonicalJson(item)).join(',')}]`

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }

  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`)
}
