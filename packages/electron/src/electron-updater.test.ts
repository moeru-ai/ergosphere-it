import type { AppUpdater, ProgressInfo } from 'electron-updater'

import type { InstallerProgress } from './installer'

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createKeyPair } from '@ergosphere-it/protocol'
import { buildInstallerRelease, feedFileName } from '@ergosphere-it/publish'
// NOTICE:
// electron-updater does not export its feed parser and its file choice. The tests need the code that installs use.
// Source: node_modules/electron-updater/out/providers/Provider.d.ts, parseUpdateInfo.
// Removal condition: electron-updater exports them from its entry.
import { findFile, parseUpdateInfo } from 'electron-updater/out/providers/Provider'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createElectronUpdaterInstaller } from './electron-updater'

const update = { sha512: 'bWFj', size: 100, updaterFeedUrl: 'https://updates.test/installers/8/feeds/darwin-arm64', url: 'https://downloads.test/AIRI-arm64-mac.zip', version: '0.14.0' }

/** An electron-updater instance without Electron. It answers a check with `version`, and downloads `file`. */
function fakeUpdater(version: string | undefined, file = '/tmp/AIRI-arm64-mac.zip') {
  const emitter = new EventEmitter()
  const updater = Object.assign(emitter, {
    allowDowngrade: false,
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
  it('downloads from the generic feed of the installer release, without installing it on its own', async () => {
    const updater = fakeUpdater('0.14.0')
    const progress: InstallerProgress[] = []

    const file = await (await createElectronUpdaterInstaller(updater)).download(update, value => progress.push(value))

    expect(file).toBe('/tmp/AIRI-arm64-mac.zip')
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: update.updaterFeedUrl })
    expect([updater.autoDownload, updater.autoInstallOnAppQuit]).toEqual([false, false])
    // The release ID of the signed manifest orders installers, so a lower version installs too.
    expect(updater.allowDowngrade).toBe(true)
    expect(progress).toEqual([{ phase: 'download', totalBytes: 100, transferredBytes: 40 }])
    expect(updater.listenerCount('download-progress')).toBe(0)
  })

  it('refuses a feed that offers another version than the signed installer manifest', async () => {
    await expect((await createElectronUpdaterInstaller(fakeUpdater('0.15.0'))).download(update, () => {})).rejects.toThrow('offers 0.15.0')
    await expect((await createElectronUpdaterInstaller(fakeUpdater(undefined))).download(update, () => {})).rejects.toThrow('must not be the version of this app')
  })

  it('installs through quitAndInstall, and installs on quit only until it discards the update', async () => {
    const updater = fakeUpdater('0.14.0')
    const installer = await createElectronUpdaterInstaller(updater)
    installer.installOnQuit()
    expect(updater.autoInstallOnAppQuit).toBe(true)

    installer.discard()
    expect(updater.autoInstallOnAppQuit).toBe(false)

    installer.install()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })
})

describe('installer release feeds', () => {
  it('are feeds that electron-updater reads', async () => {
    const { signingKey } = await createKeyPair()
    const release = await buildInstallerRelease({
      artifacts: [{ format: 'electron-updater', platform: 'darwin-arm64', sha512: 'bWFj', size: 100, url: update.url }],
      bundleReleaseId: 20,
      createdAt: '2026-10-24T00:00:00.000Z',
      host: 'electron',
      nativeVersion: 2,
      product: 'airi',
      releaseId: 8,
      signingKey,
      version: '0.14.0',
    })
    const feed = release.feedFiles[0]!
    const name = feedFileName('darwin-arm64')

    expect(parseUpdateInfo(new TextDecoder().decode(feed.bytes), name, new URL(`${update.updaterFeedUrl}/${name}`))).toMatchObject({
      files: [{ sha512: 'bWFj', size: 100, url: update.url }],
      version: '0.14.0',
    })
  })

  // A deb and an rpm share the feed of their platform. The Linux updaters of electron-updater choose by extension.
  it('let each Linux updater of electron-updater find the file of its package', async () => {
    const { signingKey } = await createKeyPair()
    const deb = 'https://downloads.test/AIRI-0.14.0-linux-amd64.deb'
    const rpm = 'https://downloads.test/AIRI-0.14.0-linux-x86_64.rpm'
    const release = await buildInstallerRelease({
      artifacts: [
        { format: 'electron-updater', packageType: 'deb', platform: 'linux-x64', sha512: 'ZGVi', size: 100, url: deb },
        { format: 'electron-updater', packageType: 'rpm', platform: 'linux-x64', sha512: 'cnBt', size: 100, url: rpm },
      ],
      bundleReleaseId: 20,
      host: 'electron',
      nativeVersion: 2,
      product: 'airi',
      releaseId: 8,
      signingKey,
      version: '0.14.0',
    })
    const name = feedFileName('linux-x64')
    const info = parseUpdateInfo(new TextDecoder().decode(release.feedFiles[0]!.bytes), name, new URL(`https://updates.test/installers/8/feeds/linux-x64/${name}`))
    const files = info.files.map(file => ({ info: file, url: new URL(file.url) }))

    // The extensions and the excluded extensions of DebUpdater, RpmUpdater, and AppImageUpdater.
    expect(findFile(files, 'deb', ['AppImage', 'rpm', 'pacman'])?.info.url).toBe(deb)
    expect(findFile(files, 'rpm', ['AppImage', 'deb', 'pacman'])?.info.url).toBe(rpm)
    expect(findFile(files, 'AppImage', ['rpm', 'deb', 'pacman'])).toBeUndefined()
  })
})

describe('linuxPackageType', () => {
  let resources: string | undefined

  afterEach(() => {
    vi.doUnmock('node:process')
    vi.resetModules()
    if (resources)
      rmSync(resources, { force: true, recursive: true })
    resources = undefined
  })

  async function packageTypeOn(platform: string, packageType?: string) {
    if (resources)
      rmSync(resources, { force: true, recursive: true })
    resources = mkdtempSync(join(tmpdir(), 'ergosphere-resources-'))
    if (packageType)
      writeFileSync(join(resources, 'package-type'), `${packageType}\n`)
    const actual = await vi.importActual<typeof import('node:process')>('node:process')
    vi.doMock('node:process', () => ({ ...actual, platform, resourcesPath: resources }))
    vi.resetModules()
    const { linuxPackageType } = await import('./electron-updater')

    return linuxPackageType()
  }

  it.each([
    { expected: 'deb', packageType: 'deb' },
    { expected: 'rpm', packageType: 'rpm' },
    { expected: 'pacman', packageType: 'pacman' },
    { expected: 'appimage', packageType: undefined },
    { expected: 'appimage', packageType: 'snap' },
  ])('reads $packageType from the resources of electron-builder as $expected', async ({ expected, packageType }) => {
    expect(await packageTypeOn('linux', packageType)).toBe(expected)
  })

  it('names no package on macOS and Windows', async () => {
    expect(await packageTypeOn('darwin', 'deb')).toBeUndefined()
    expect(await packageTypeOn('win32')).toBeUndefined()
  })
})
