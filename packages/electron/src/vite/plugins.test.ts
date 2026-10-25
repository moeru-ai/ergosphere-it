import type { Plugin, UserConfig } from 'vite'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ergosphereMain from './main'
import ergospherePreload from './preload'
import ergosphereRenderer from './renderer'

let root: string

/** Runs the config hook of a plugin, as Vite does after the preset of electron-vite. */
function configure(plugin: Plugin, config: UserConfig): UserConfig {
  ;(plugin.config as (config: UserConfig, env: { command: 'build', mode: string }) => void)(config, { command: 'build', mode: 'production' })

  return config
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ergosphere-vite-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'out/launcher/index.mjs', name: 'app', version: '1.0.0' }))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('ergosphereMain', () => {
  it('builds the launcher and the main of the bundle from the entry that the preset found', () => {
    const rolldownOptions = { output: { assetFileNames: 'chunks/[name]-[hash].[ext]' } }
    const config = configure(ergosphereMain({ root }), { build: { lib: { entry: join(root, 'src/main/index.ts'), formats: ['es'] }, rolldownOptions, rollupOptions: rolldownOptions } })

    expect(config.build?.lib).toBe(false)
    expect(config.build?.outDir).toBe(join(root, 'out'))
    expect(config.build?.rolldownOptions?.input).toEqual({ 'bundle/main/index': join(root, 'src/main/index.ts'), 'launcher/index': 'virtual:ergosphere-it/launcher' })
    // The preset points rollupOptions at the same object, so it sees the change too.
    expect(config.build?.rollupOptions).toBe(config.build?.rolldownOptions)
    // Assets and chunks of main go into the bundle, so a downloaded bundle has them too.
    expect(config.build?.rolldownOptions?.output).toMatchObject({ assetFileNames: 'bundle/main/chunks/[name]-[hash][extname]', chunkFileNames: 'bundle/main/chunks/[name]-[hash].mjs', format: 'es' })
  })

  it('keeps every main entry of the config, starts from index, and names other entry chunks into the bundle', () => {
    const config = configure(ergosphereMain({ root }), { build: { lib: { entry: { index: 'src/main/index.ts', sync: 'src/main/sync.ts' } } } })
    const output = config.build?.rolldownOptions?.output as { entryFileNames: (chunk: { name: string }) => string }

    expect(config.build?.rolldownOptions?.input).toEqual({
      'bundle/main/index': join(root, 'src/main/index.ts'),
      'bundle/main/sync': join(root, 'src/main/sync.ts'),
      'launcher/index': 'virtual:ergosphere-it/launcher',
    })
    expect(output.entryFileNames({ name: 'bundle/main/sync' })).toBe('[name].mjs')
    expect(output.entryFileNames({ name: 'launcher/index' })).toBe('[name].mjs')
    // A worker of a `?nodeWorker` import is an entry chunk too, and lands next to the main code.
    expect(output.entryFileNames({ name: 'worker' })).toBe('bundle/main/[name]-[hash].mjs')
  })

  it('takes entries as a path, a list, or an object, and starts from the only entry', () => {
    const fromList = configure(ergosphereMain({ outDir: 'list', root }), { build: { rolldownOptions: { input: ['src/main/app.ts'] } } })
    const fromObject = configure(ergosphereMain({ outDir: 'object', root }), { build: { rolldownOptions: { input: { app: 'src/main/app.ts' } } } })

    expect(fromList.build?.rolldownOptions?.input).toMatchObject({ 'bundle/main/app': join(root, 'src/main/app.ts') })
    expect(fromObject.build?.rolldownOptions?.input).toMatchObject({ 'bundle/main/app': join(root, 'src/main/app.ts') })
  })

  it('keeps the input of a second build of electron-vite, for a `?modulePath` script, and adds no launcher', () => {
    const config = configure(ergosphereMain({ outDir: 'module-path', root }), { build: { lib: { entry: 'src/main/index.ts' }, rolldownOptions: { input: join(root, 'src/main/fork.ts') }, write: false } })

    expect(config.build?.lib).toBe(false)
    expect(config.build?.rolldownOptions?.input).toBe(join(root, 'src/main/fork.ts'))
    expect(config.build?.rolldownOptions?.output).toMatchObject({ chunkFileNames: 'bundle/main/chunks/[name]-[hash].mjs', format: 'es' })
  })

  it('refuses entries without one to start from, and a list of outputs', () => {
    expect(() => configure(ergosphereMain({ root }), { build: { rolldownOptions: { input: { app: 'src/a.ts', sync: 'src/b.ts' } } } })).toThrow('Name the entry that starts the app index')
    expect(() => configure(ergosphereMain({ root }), { build: { rolldownOptions: { output: [{}, {}] } } })).toThrow('one output')
  })

  it('takes an entry and a launcher of the app', () => {
    const config = configure(ergosphereMain({ entry: 'src/app.ts', launcher: 'src/launcher.ts', root }), { build: { rolldownOptions: { input: join(root, 'src/ignored.ts') } } })

    expect(config.build?.rolldownOptions?.input).toEqual({ 'bundle/main/index': join(root, 'src/app.ts'), 'launcher/index': join(root, 'src/launcher.ts') })
  })

  it('warns when package.json does not start the launcher', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'out/main/index.js', name: 'app' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configure(ergosphereMain({ root }), {})

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('out/launcher/index.mjs'))
    warn.mockRestore()
  })
})

describe('ergospherePreload', () => {
  it('builds the preload script into the bundle as CommonJS', () => {
    const config = configure(ergospherePreload({ root }), { build: { lib: { entry: join(root, 'src/preload/index.ts'), formats: ['es'] } } })

    expect(config.build?.lib).toBe(false)
    expect(config.build?.outDir).toBe(join(root, 'out', 'bundle', 'preload'))
    expect(config.build?.rolldownOptions?.input).toEqual({ index: join(root, 'src/preload/index.ts') })
    expect(config.build?.rolldownOptions?.output).toMatchObject({ chunkFileNames: 'chunks/[name]-[hash].cjs', entryFileNames: '[name].cjs', format: 'cjs' })
  })

  it('keeps every preload entry of the config, by name', () => {
    const entry = { 'beat-sync': 'src/preload/beat-sync.ts', 'index': 'src/preload/index.ts' }
    const config = configure(ergospherePreload({ root }), { build: { lib: { entry } } })

    expect(config.build?.rolldownOptions?.input).toEqual({ 'beat-sync': join(root, 'src/preload/beat-sync.ts'), 'index': join(root, 'src/preload/index.ts') })
  })

  it('refuses two entries of one name', () => {
    expect(() => configure(ergospherePreload({ root }), { build: { rolldownOptions: { input: ['src/a/index.ts', 'src/b/index.ts'] } } })).toThrow('Two preload entries have the name index')
  })

  it('warns about an entry that requires a shared chunk, which a sandboxed window cannot load', () => {
    const plugin = ergospherePreload({ root })
    const warn = vi.fn()
    const bundle = {
      'chunks/shared-1.cjs': { fileName: 'chunks/shared-1.cjs', imports: [], isEntry: false, type: 'chunk' },
      'index.cjs': { fileName: 'index.cjs', imports: ['chunks/shared-1.cjs'], isEntry: true, type: 'chunk' },
      // electron is external: a sandboxed preload script can require it.
      'other.cjs': { fileName: 'other.cjs', imports: ['electron'], isEntry: true, type: 'chunk' },
    }
    ;(plugin.generateBundle as unknown as (this: { warn: typeof warn }, options: unknown, bundle: unknown) => void).call({ warn }, {}, bundle)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('index.cjs requires chunks/shared-1.cjs'))
  })
})

describe('ergosphereRenderer', () => {
  it('keeps every HTML entry, and builds the pages into the bundle with relative paths', () => {
    const input = { 'beat-sync': join(root, 'src/renderer/beat-sync.html'), 'main': join(root, 'src/renderer/index.html') }
    const config = configure(ergosphereRenderer({ outDir: 'dist-out', root }), { build: { rolldownOptions: { input } } })

    expect(config.build?.rolldownOptions?.input).toEqual(input)
    expect(config.build?.outDir).toBe(join(root, 'dist-out', 'bundle', 'renderer'))
    expect(config.base).toBe('./')
  })
})
