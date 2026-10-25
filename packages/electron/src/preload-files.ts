import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { BUNDLE_LAYOUT } from './layout'

// The preload scripts of a bundle are read from the disk, not from `bundle.json`. Under `electron-vite dev` the
// renderer plugin does not run, so the build has no `bundle.json`, and the scripts are still on the disk.

/**
 * The path of the default preload script of a bundle: the entry that `bundle.json` names, else the entry named `index`,
 * else the only entry. Throws when there are several entries and none named `index`.
 */
export function defaultPreloadPathOf(bundleDir: string, entry: string | undefined): string {
  if (entry !== undefined)
    return join(bundleDir, ...entry.split('/'))

  const names = preloadNamesOf(bundleDir)
  const name = names.includes('index') ? 'index' : names.length === 1 ? names[0] : undefined
  if (name === undefined)
    throw new Error(`The bundle has no preload entry named index. It has ${describe(names)}. Use activeBundle.preloadOf(name).`)

  return join(bundleDir, BUNDLE_LAYOUT.preloadDir, `${name}.cjs`)
}

/** The names of the preload entries of a bundle: the `<name>.cjs` files at the top of its preload directory. */
export function preloadNamesOf(bundleDir: string): string[] {
  try {
    return readdirSync(join(bundleDir, BUNDLE_LAYOUT.preloadDir)).filter(file => file.endsWith('.cjs')).map(file => file.slice(0, -'.cjs'.length)).sort()
  }
  catch {
    return []
  }
}

/** The path of a preload entry of a bundle. Throws when the bundle has no such entry, and names the entries it has. */
export function preloadPathOf(bundleDir: string, name: string): string {
  const path = join(bundleDir, BUNDLE_LAYOUT.preloadDir, `${name}.cjs`)
  if (!existsSync(path))
    throw new Error(`The bundle has no preload entry ${name}. It has ${describe(preloadNamesOf(bundleDir))}.`)

  return path
}

function describe(names: string[]): string {
  return names.length > 0 ? names.join(', ') : 'no preload script'
}
