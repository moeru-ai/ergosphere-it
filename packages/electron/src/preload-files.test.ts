import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultPreloadPathOf, preloadNamesOf, preloadPathOf } from './preload-files'

let bundle: string

/** Writes preload scripts into the bundle, and a shared chunk, which is not an entry. */
function writePreloads(...names: string[]): void {
  mkdirSync(join(bundle, 'preload', 'chunks'), { recursive: true })
  writeFileSync(join(bundle, 'preload', 'chunks', 'shared-1.cjs'), '')
  for (const name of names)
    writeFileSync(join(bundle, 'preload', `${name}.cjs`), '')
}

beforeEach(() => {
  bundle = mkdtempSync(join(tmpdir(), 'ergosphere-preload-'))
})

afterEach(() => {
  rmSync(bundle, { force: true, recursive: true })
})

describe('preload files', () => {
  it('finds the entries on the disk, as under electron-vite dev without bundle.json', () => {
    writePreloads('index', 'beat-sync')

    expect(preloadNamesOf(bundle)).toEqual(['beat-sync', 'index'])
    expect(preloadPathOf(bundle, 'beat-sync')).toBe(join(bundle, 'preload', 'beat-sync.cjs'))
    expect(defaultPreloadPathOf(bundle, undefined)).toBe(join(bundle, 'preload', 'index.cjs'))
  })

  it('takes the entry of bundle.json, else index, else the only entry', () => {
    writePreloads('settings')

    expect(defaultPreloadPathOf(bundle, 'preload/settings.cjs')).toBe(join(bundle, 'preload', 'settings.cjs'))
    expect(defaultPreloadPathOf(bundle, undefined)).toBe(join(bundle, 'preload', 'settings.cjs'))
  })

  it('names the entries that the bundle has when one is missing or there is no default', () => {
    writePreloads('chat', 'settings')

    expect(() => preloadPathOf(bundle, 'beat-sync')).toThrow('The bundle has no preload entry beat-sync. It has chat, settings.')
    expect(() => defaultPreloadPathOf(bundle, undefined)).toThrow('no preload entry named index. It has chat, settings')
    expect(preloadNamesOf(join(bundle, 'missing'))).toEqual([])
  })
})
