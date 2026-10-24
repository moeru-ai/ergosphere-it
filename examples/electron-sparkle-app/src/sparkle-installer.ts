import type { Installer } from '@ergosphere-it/electron/launcher'
import type { SparkleBridge, SparkleBridgeEvent } from 'electron-sparkle-updater'

import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

/**
 * Wraps Sparkle as the installer of the app on macOS.
 *
 * The installer release names the appcast as the file of `darwin-<arch>`, so the signed manifest pins the bytes of the
 * appcast. The appcast pins each archive and each delta with EdDSA, and Sparkle checks them against `SUPublicEDKey`.
 * Sparkle downloads the smallest delta chain, applies it, and checks the result before it reports the update.
 *
 * `download` returns the appcast file, so the launcher checks it against the manifest once more.
 */
export function createSparkleInstaller(bridge: SparkleBridge): Installer {
  let listener: ((event: SparkleBridgeEvent) => void) | undefined
  bridge.setEventHandler(event => listener?.(event))

  return {
    async download(update, onProgress) {
      const response = await fetch(update.url)
      if (!response.ok)
        throw new Error(`The appcast at ${update.url} returned HTTP ${response.status}.`)

      const appcast = new Uint8Array(await response.arrayBuffer())
      if (createHash('sha512').update(appcast).digest('base64') !== update.sha512)
        throw new Error(`The appcast at ${update.url} does not match the signed installer manifest.`)

      const file = join(app.getPath('temp'), `ergosphere-sparkle-appcast-${update.version}.xml`)
      await writeFile(file, appcast)

      // Sparkle reads the appcast again from the URL. The EdDSA signatures in it still guard each archive.
      if (!bridge.init({ appcastUrl: update.url }))
        throw new Error('Sparkle did not start.')

      await new Promise<void>((resolve, reject) => {
        listener = (event) => {
          if (event.type === 'download-progress' && event.phase === 'download' && event.total) {
            onProgress(event.transferred ?? 0, event.total)
          }
          else if (event.type === 'update-downloaded') {
            if (event.version === update.version)
              return resolve()

            bridge.discardDownloadedUpdate()
            reject(new Error(`Sparkle got ${event.version} from ${update.url}, and the installer manifest says ${update.version}.`))
          }
          else if (event.type === 'update-not-available' || event.type === 'error') {
            reject(new Error(`Sparkle found no update at ${update.url}: ${event.message ?? event.type}`))
          }
        }
        bridge.checkForUpdates()
      }).finally(() => {
        listener = undefined
      })

      return file
    },
    install() {
      bridge.installUpdateNow()
    },
    installOnQuit() {
      bridge.installUpdateOnQuit()
    },
  }
}
