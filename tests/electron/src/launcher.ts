// The launcher of the test build: the generated launcher with settings from the environment, and installers that
// download without installing: one for installer files, and one that acts as Sparkle.

import type { ElectronUpdaterInstaller, SparkleInstaller } from '@ergosphere-it/electron/launcher'
import type { TrustedKey } from '@ergosphere-it/protocol'

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, pid } from 'node:process'

import config from 'virtual:ergosphere-it/config'

import { startLauncher } from '@ergosphere-it/electron/launcher'
import { app } from 'electron'

if (env.ERGOSPHERE_USER_DATA)
  app.setPath('userData', env.ERGOSPHERE_USER_DATA)

/**
 * The file installer of the e2e test. An app that is not packaged cannot install with electron-updater, so this
 * installer downloads the file and quits on install. The launcher still checks the file against the signed manifest.
 */
function e2eFileInstaller(): ElectronUpdaterInstaller {
  return {
    discard() {},
    async download(update, onProgress) {
      const bytes = new Uint8Array(await (await fetch(update.url)).arrayBuffer())
      onProgress({ phase: 'download', totalBytes: update.size, transferredBytes: bytes.byteLength })
      const file = join(app.getPath('temp'), `ergosphere-e2e-${pid}-${update.version}.zip`)
      writeFileSync(file, bytes)

      return file
    },
    format: 'electron-updater',
    install() {
      app.exit(0)
    },
    installOnQuit() {},
  }
}

/**
 * The Sparkle installer of the e2e test. Sparkle runs only in a packaged macOS app, so this installer reads the appcast
 * that the launcher serves, and reports its newest version as Sparkle does. It quits on install.
 */
function e2eSparkleInstaller(): SparkleInstaller {
  return {
    discard() {
      console.info('[e2e] sparkle discard')
    },
    format: 'sparkle',
    install() {
      app.exit(0)
    },
    installOnQuit() {},
    async prepare(appcast, onProgress) {
      const text = await (await fetch(appcast.url)).text()
      const versions = [...text.matchAll(/<sparkle:shortVersionString>([^<]+)</g)].map(match => match[1]!)
      onProgress({ phase: 'download', totalBytes: 100, transferredBytes: 100 })
      onProgress({ percent: 50, phase: 'prepare' })

      return { version: versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? '' }
    },
  }
}

const installers = { file: e2eFileInstaller, sparkle: e2eSparkleInstaller }

startLauncher({
  ...config,
  applyMode: env.ERGOSPHERE_APPLY_MODE === 'auto' ? 'auto' : 'prompt',
  checkIntervalMs: Number(env.ERGOSPHERE_CHECK_MS ?? config.checkIntervalMs),
  feedUrl: env.ERGOSPHERE_FEED_URL ?? config.feedUrl,
  installer: installers[env.ERGOSPHERE_E2E_INSTALLER as keyof typeof installers]?.() ?? undefined,
  launcherUrl: import.meta.url,
  launchHealthTimeoutMs: Number(env.ERGOSPHERE_BOOT_HEALTH_MS ?? 60_000),
  reloadHealthTimeoutMs: Number(env.ERGOSPHERE_HEALTH_MS ?? 15_000),
  // Each test run signs with its own key.
  trustedKeys: env.ERGOSPHERE_TRUSTED_KEYS ? JSON.parse(env.ERGOSPHERE_TRUSTED_KEYS) as TrustedKey[] : config.trustedKeys,
}).catch((error) => {
  console.error('[ergosphere-it] The test launcher failed.', error)
  app.exit(1)
})
