import type { Component } from '@ergosphere-it/protocol'

export type Activation = 'none' | 'reload' | 'restart'

function fileMap(components: readonly Component[]): Map<string, { sha256: string, type: Component['type'] }> {
  const files = new Map<string, { sha256: string, type: Component['type'] }>()
  for (const component of components) {
    for (const file of component.files)
      files.set(file.path, { sha256: file.sha256, type: component.type })
  }

  return files
}

/**
 * Decides how a core change takes effect.
 *
 * A change that touches only `web` files reloads the pages. Any other change restarts the app.
 */
export function activationFor(running: readonly Component[], next: readonly Component[]): Activation {
  const before = fileMap(running)
  const after = fileMap(next)
  let changed = false

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path)
    const b = after.get(path)
    if (a?.sha256 === b?.sha256 && a?.type === b?.type)
      continue

    changed = true
    if ((a !== undefined && a.type !== 'web') || (b !== undefined && b.type !== 'web'))
      return 'restart'
  }

  return changed ? 'reload' : 'none'
}
