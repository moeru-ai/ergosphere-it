import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withUpdates } from './vite'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ergosphere-vite-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'out/launcher/index.mjs', name: 'app', version: '1.0.0' }))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('withUpdates', () => {
  it('keeps every HTML entry of the renderer, so a multi-page app builds all its pages into the bundle', () => {
    const input = { 'beat-sync': join(root, 'src/renderer/beat-sync.html'), 'main': join(root, 'src/renderer/index.html') }
    const config = withUpdates({ renderer: { build: { rolldownOptions: { input } } } }, { root })

    expect(config.renderer?.build?.rolldownOptions?.input).toEqual(input)
    expect(config.renderer?.build?.outDir).toBe(join(root, 'out', 'bundle', 'renderer'))
    expect(config.renderer?.base).toBe('./')
  })

  it('builds index.html when the app names no entry', () => {
    const config = withUpdates({}, { root })

    expect(config.renderer?.build?.rolldownOptions?.input).toBe(join(root, 'src', 'renderer', 'index.html'))
  })

  it('warns when package.json does not start the launcher', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'out/main/index.js', name: 'app' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withUpdates({}, { root })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('out/launcher/index.mjs'))
    warn.mockRestore()
  })
})
