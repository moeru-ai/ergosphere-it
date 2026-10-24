import type { SparkleBridge, SparkleBridgeEvent } from 'electron-sparkle-updater'

import type { SparkleInstaller } from './installer'

export type { InstallerProgress, SparkleAppcast, SparkleInstaller } from './installer'

/**
 * Wraps Sparkle as the installer of the app on macOS, through electron-sparkle-updater.
 *
 * Without an argument, it loads the bridge of the packaged app, and returns `undefined` on other platforms or when the
 * native addon is missing. Sparkle reads its public key from `SUPublicEDKey` in `Info.plist`.
 *
 * The launcher owns the schedule, so the installer turns off the automatic checks of Sparkle each time it starts it.
 */
export async function createSparkleInstaller(bridge?: SparkleBridge): Promise<SparkleInstaller | undefined> {
  const loaded = bridge ?? await loadBridge()
  if (!loaded)
    return undefined

  let listener: ((event: SparkleBridgeEvent) => void) | undefined
  loaded.setEventHandler(event => listener?.(event))

  return {
    discard() {
      loaded.discardDownloadedUpdate()
    },
    format: 'sparkle',
    install() {
      loaded.installUpdateNow()
    },
    installOnQuit() {
      loaded.installUpdateOnQuit()
    },
    async prepare(appcast, onProgress) {
      if (!loaded.init({ appcastUrl: appcast.url }))
        throw new Error('Sparkle did not start. Check SUPublicEDKey in Info.plist and the code signature of the app.')
      // Sparkle turns its scheduled checks on when it starts. Its own schedule would skip the channel, the rollout, and
      // the withdrawn list of the launcher.
      loaded.setAutomaticChecks(false)

      try {
        return await new Promise<{ version: string }>((resolve, reject) => {
          listener = (event) => {
            switch (event.type) {
              case 'download-progress':
                if (event.phase === 'apply')
                  onProgress({ percent: Math.floor(event.percent ?? 0), phase: 'prepare' })
                else if (event.total)
                  onProgress({ phase: 'download', totalBytes: event.total, transferredBytes: event.transferred ?? 0 })

                return
              case 'error':
              case 'update-not-available':
                return reject(new Error(`Sparkle found no update in ${appcast.url}: ${event.message ?? event.type}`))
              case 'update-downloaded':
                return resolve({ version: event.version ?? '' })
            }
          }
          loaded.checkForUpdates()
        })
      }
      finally {
        listener = undefined
      }
    },
  }
}

async function loadBridge(): Promise<SparkleBridge | undefined> {
  try {
    const { loadSparkleBridgeForApp } = await import('electron-sparkle-updater')

    return await loadSparkleBridgeForApp(message => console.warn('[ergosphere-it] Sparkle:', message)) ?? undefined
  }
  catch {
    // electron-sparkle-updater is not installed.
    return undefined
  }
}
