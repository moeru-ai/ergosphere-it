import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveStore } from './store'

let root: string

/** Writes an `ergo.config.mjs` whose store, when there is one, names itself `config-store`. */
function writeConfig(withStore: boolean): void {
  const noop = 'async () => {}'
  const store = withStore ? `store: { name: 'config-store', getChannel: ${noop}, hasObject: ${noop}, putBundle: ${noop}, putChannel: ${noop}, putInstaller: ${noop}, putObject: ${noop} },` : ''
  writeFileSync(join(root, 'ergo.config.mjs'), `export default { ${store} channel: 'stable', feedUrl: 'https://updates.example.com', nativeVersion: 1, publicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnCGr/Q1PZzU/9dlC4UH/Pb1uml+D4Bzcojc9U2vX9m'] }\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ergosphere-store-'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('resolveStore', () => {
  it('takes the URL of --store, then ERGOSPHERE_IT_STORE, before store of ergo.config.ts', async () => {
    writeConfig(true)

    expect((await resolveStore(join(root, 'tree'), undefined, root)).store.name).toBe(join(root, 'tree'))
    expect((await resolveStore(undefined, 's3://updates/my-app', root)).store.name).toBe('s3://updates/my-app')
    expect((await resolveStore(undefined, undefined, root))).toMatchObject({ source: 'ergo.config.ts', store: { name: 'config-store' } })
  })

  it('says where to set a store when there is none', async () => {
    await expect(resolveStore(undefined, undefined, root)).rejects.toThrow('no release store')
    writeConfig(false)
    await expect(resolveStore(undefined, undefined, root)).rejects.toThrow('no release store')
  })

  it('rejects a store in ergo.config.ts without the callbacks of a release store', async () => {
    writeFileSync(join(root, 'ergo.config.mjs'), `export default { store: { getChannel: async () => undefined },  channel: 'stable', feedUrl: 'https://updates.example.com', nativeVersion: 1, publicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnCGr/Q1PZzU/9dlC4UH/Pb1uml+D4Bzcojc9U2vX9m'] }\n`)

    await expect(resolveStore(undefined, undefined, root)).rejects.toThrow('must come from createS3Store(), createFileTreeStore(), or createReleaseStore()')
  })
})
