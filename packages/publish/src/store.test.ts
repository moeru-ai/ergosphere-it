import { describe, expect, it } from 'vitest'

import { createReleaseStore, isReleaseStore } from './store'

const callbacks = {
  getChannel: async () => undefined,
  putBundle: async () => {},
  putChannel: async () => {},
  putInstaller: async () => {},
  putObject: async () => {},
}

describe('createReleaseStore', () => {
  it('fills the defaults of the optional callbacks', async () => {
    const store = createReleaseStore(callbacks)

    expect(await store.hasObject('a'.repeat(64))).toBe(false)
    expect(store.name).toBe('the release store')
    expect(store.listChannels).toBeUndefined()
    expect(isReleaseStore(store)).toBe(true)
  })

  it('names the callbacks that are missing', () => {
    const { putChannel: _, putObject: __, ...partial } = callbacks

    expect(() => createReleaseStore(partial as never)).toThrow('the release store has no putChannel, putObject')
    expect(isReleaseStore(partial)).toBe(false)
  })
})
