import type { Runtime } from './runtime'

// The launcher and the bundle can load separate copies of this package, so the runtime lives on `globalThis`.
const RUNTIME_KEY = Symbol.for('ergosphere-it.runtime')

export function readRuntime(): Runtime | undefined {
  return (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] as Runtime | undefined
}

export function writeRuntime(runtime: Runtime): void {
  (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = runtime
}
