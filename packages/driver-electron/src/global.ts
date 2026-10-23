import type { Core } from './core'

// The shell and the core can load separate copies of this package, so the core lives on `globalThis`.
const CORE_KEY = Symbol.for('ergosphere-it.core')

export function readCore(): Core | undefined {
  return (globalThis as Record<symbol, unknown>)[CORE_KEY] as Core | undefined
}

export function writeCore(core: Core): void {
  (globalThis as Record<symbol, unknown>)[CORE_KEY] = core
}
