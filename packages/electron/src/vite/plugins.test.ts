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
    expect(config.build?.rolldownOptions?.output).toMatchObject({ assetFileNames: 'chunks/[name]-[hash].[ext]', entryFileNames: '[name].mjs', format: 'es' })
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
    expect(config.build?.rolldownOptions?.input).toBe(join(root, 'src/preload/index.ts'))
    expect(config.build?.rolldownOptions?.output).toMatchObject({ entryFileNames: 'index.cjs', format: 'cjs' })
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
