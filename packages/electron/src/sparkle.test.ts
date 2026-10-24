import type { SparkleBridge, SparkleBridgeEvent } from 'electron-sparkle-updater'

import type { InstallerProgress } from './installer'

import { describe, expect, it, vi } from 'vitest'

import { createSparkleInstaller } from './sparkle'

/** A bridge without Sparkle. A check sends `events` in order. */
function fakeBridge(events: SparkleBridgeEvent[]) {
  let handler: ((event: SparkleBridgeEvent) => void) | null = null
  const calls: string[] = []
  const bridge = {
    checkForUpdates: vi.fn(() => {
      calls.push('checkForUpdates')
      for (const event of events)
        handler?.(event)
    }),
    discardDownloadedUpdate: vi.fn(),
    init: vi.fn((options: { appcastUrl: string }) => {
      calls.push(`init ${options.appcastUrl}`)

      return true
    }),
    installUpdateNow: vi.fn(),
    installUpdateOnQuit: vi.fn(),
    setAutomaticChecks: vi.fn((enabled: boolean) => calls.push(`setAutomaticChecks ${enabled}`)),
    setEventHandler: vi.fn((next: typeof handler) => {
      handler = next
    }),
  } satisfies SparkleBridge

  return { bridge, calls }
}

const appcast = { url: 'http://127.0.0.1:4100/abc/appcast.xml', version: '1.1.0' }

describe('createSparkleInstaller', () => {
  it('starts Sparkle on the appcast with its own checks off, and reports download and patch progress', async () => {
    const { bridge, calls } = fakeBridge([
      { type: 'checking' },
      { type: 'update-available', version: '1.1.0' },
      { phase: 'download', total: 6000, transferred: 3000, type: 'download-progress' },
      { percent: 42.9, phase: 'apply', type: 'download-progress' },
      { type: 'update-downloaded', version: '1.1.0' },
    ])
    const installer = (await createSparkleInstaller(bridge))!
    const progress: InstallerProgress[] = []

    expect(await installer.prepare(appcast, value => progress.push(value))).toEqual({ version: '1.1.0' })
    expect(calls).toEqual([`init ${appcast.url}`, 'setAutomaticChecks false', 'checkForUpdates'])
    expect(progress).toEqual([{ phase: 'download', totalBytes: 6000, transferredBytes: 3000 }, { percent: 42, phase: 'prepare' }])
  })

  it('returns the version that Sparkle got, so the launcher can compare it with the manifest', async () => {
    const { bridge } = fakeBridge([{ type: 'update-downloaded', version: '1.2.0' }])

    expect(await (await createSparkleInstaller(bridge))!.prepare(appcast, () => {})).toEqual({ version: '1.2.0' })
  })

  it('fails when Sparkle finds nothing or reports an error', async () => {
    await expect((await createSparkleInstaller(fakeBridge([{ type: 'update-not-available' }]).bridge))!.prepare(appcast, () => {})).rejects.toThrow('update-not-available')
    await expect((await createSparkleInstaller(fakeBridge([{ message: 'bad signature', type: 'error' }]).bridge))!.prepare(appcast, () => {})).rejects.toThrow('bad signature')
  })

  it('installs now, installs on quit, and discards through the bridge', async () => {
    const { bridge } = fakeBridge([])
    const installer = (await createSparkleInstaller(bridge))!
    installer.install()
    installer.installOnQuit()
    installer.discard()

    expect([bridge.installUpdateNow, bridge.installUpdateOnQuit, bridge.discardDownloadedUpdate].map(spy => spy.mock.calls.length)).toEqual([1, 1, 1])
  })
})
