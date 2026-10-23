import type { AppUpdater, ProgressInfo } from 'electron-updater'

import { EventEmitter } from 'node:events'

import { createKeyPair } from '@ergosphere-it/protocol'
import { buildShellRelease, feedFileName } from '@ergosphere-it/publish'
// NOTICE:
// electron-updater does not export its feed parser. The test needs the parser that installs use.
// Source: node_modules/electron-updater/out/providers/Provider.d.ts, parseUpdateInfo.
// Removal condition: electron-updater exports a feed parser from its entry.
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider'
import { describe, expect, it, vi } from 'vitest'

import { createElectronUpdaterInstaller } from './electron-updater'

const update = { feedUrl: 'https://updates.test/shells/8/feeds/darwin-arm64', sha512: 'bWFj', size: 100, url: 'https://downloads.test/AIRI-arm64-mac.zip', version: '0.14.0' }

/** An electron-updater instance without Electron. It answers a check with `version`, and downloads `file`. */
function fakeUpdater(version: string | undefined, file = '/tmp/AIRI-arm64-mac.zip') {
  const emitter = new EventEmitter()
  const updater = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => (version === undefined ? null : { cancellationToken: undefined, isUpdateAvailable: true, updateInfo: { version } })),
    downloadUpdate: vi.fn(async () => {
      emitter.emit('download-progress', { total: 100, transferred: 40 } as ProgressInfo)

      return [file]
    }),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  })

  return updater as AppUpdater & typeof updater
}

describe('createElectronUpdaterInstaller', () => {
  it('downloads from the generic feed of the shell release, without installing it on its own', async () => {
    const updater = fakeUpdater('0.14.0')
    const progress: number[][] = []

    const file = await createElectronUpdaterInstaller(updater).download(update, (downloaded, total) => progress.push([downloaded, total]))

    expect(file).toBe('/tmp/AIRI-arm64-mac.zip')
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: update.feedUrl })
    expect([updater.autoDownload, updater.autoInstallOnAppQuit]).toEqual([false, false])
    expect(progress).toEqual([[40, 100]])
    expect(updater.listenerCount('download-progress')).toBe(0)
  })

  it('refuses a feed that offers another version than the signed shell manifest', async () => {
    await expect(createElectronUpdaterInstaller(fakeUpdater('0.15.0')).download(update, () => {})).rejects.toThrow('offers 0.15.0')
    await expect(createElectronUpdaterInstaller(fakeUpdater(undefined)).download(update, () => {})).rejects.toThrow('no newer version')
  })

  it('installs through quitAndInstall', () => {
    const updater = fakeUpdater('0.14.0')
    createElectronUpdaterInstaller(updater).install()

    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })
})

describe('shell release feeds', () => {
  it('are feeds that electron-updater reads', async () => {
    const { signingKey } = await createKeyPair()
    const release = await buildShellRelease({
      artifacts: [{ platform: 'darwin-arm64', sha512: 'bWFj', size: 100, url: update.url }],
      builtinCoreSeq: 20,
      createdAt: '2026-10-24T00:00:00.000Z',
      host: 'electron',
      hostApi: 2,
      product: 'airi',
      seq: 8,
      signingKey,
      version: '0.14.0',
    })
    const feed = release.feeds[0]!
    const name = feedFileName('darwin-arm64')

    expect(parseUpdateInfo(new TextDecoder().decode(feed.bytes), name, new URL(`${update.feedUrl}/${name}`))).toMatchObject({
      files: [{ sha512: 'bWFj', size: 100, url: update.url }],
      version: '0.14.0',
    })
  })
})
