import type { BuildEnvironmentOptions } from 'vite'

import { basename, extname, resolve } from 'node:path'

/** The entry that a process starts from by default: the entry named `index`, or the only entry. */
export function defaultEntryOf(entries: Record<string, string>): string | undefined {
  const names = Object.keys(entries)
  if (names.includes('index'))
    return 'index'

  return names.length === 1 ? names[0] : undefined
}

/**
 * Reads the entries of a main or preload build as names and paths, in every form that electron-vite takes:
 * `build.lib.entry`, then `build.rolldownOptions.input`, each as a path, a list of paths, or an object of names and
 * paths. A path without a name gets the name of its file without the extension, as electron-vite names its outputs.
 * Without an entry, the entry is `src/<process>/index.ts`.
 */
export function entriesOf(build: BuildEnvironmentOptions, root: string, process: 'main' | 'preload'): Record<string, string> {
  // A lib entry wins over the input in Vite, and the preset of electron-vite sets a lib entry when there is no input.
  const lib = build.lib === false ? undefined : build.lib
  const input = lib?.entry ?? build.rolldownOptions?.input ?? resolve(root, 'src', process, 'index.ts')
  const named: [string, string][] = typeof input === 'string'
    ? [[nameOf(input), input]]
    : Array.isArray(input)
      ? input.map(path => [nameOf(path), path])
      : Object.entries(input)
  if (named.length === 0)
    throw new Error(`[ergosphere-it] The ${process} build has no entry.`)

  const entries: Record<string, string> = {}
  for (const [name, path] of named) {
    if (name in entries)
      throw new Error(`[ergosphere-it] Two ${process} entries have the name ${name}: ${entries[name]} and ${path}. Name them with an object, for example { ${name}: '...', other: '...' }.`)
    entries[name] = resolve(root, path)
  }

  return entries
}

function nameOf(path: string): string {
  return basename(path, extname(path))
}
