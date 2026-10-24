// The launcher of the test build: the generated launcher with settings from the environment, and an installer that
// downloads an installer file without installing it.

import type { Installer } from '@ergosphere-it/electron/launcher'
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
 * The installer of the e2e test. An app that is not packaged cannot install with electron-updater, so this installer
 * downloads the file and quits on install. The launcher still checks the file against the signed manifest.
 */
function e2eInstaller(): Installer {
  return {
    async download(update, onProgress) {
      const bytes = new Uint8Array(await (await fetch(update.url)).arrayBuffer())
      onProgress(bytes.byteLength, update.size)
      const file = join(app.getPath('temp'), `ergosphere-e2e-${pid}-${update.version}.zip`)
      writeFileSync(file, bytes)

      return file
    },
    install() {
      app.exit(0)
    },
  }
}

startLauncher({
  ...config,
  applyMode: env.ERGOSPHERE_APPLY_MODE === 'auto' ? 'auto' : 'prompt',
  checkIntervalMs: Number(env.ERGOSPHERE_CHECK_MS ?? config.checkIntervalMs),
  feedUrl: env.ERGOSPHERE_FEED_URL ?? config.feedUrl,
  installer: env.ERGOSPHERE_E2E_INSTALLER ? e2eInstaller() : undefined,
  launcherUrl: import.meta.url,
  launchHealthTimeoutMs: Number(env.ERGOSPHERE_BOOT_HEALTH_MS ?? 60_000),
  reloadHealthTimeoutMs: Number(env.ERGOSPHERE_HEALTH_MS ?? 15_000),
  // Each test run signs with its own key.
  trustedKeys: env.ERGOSPHERE_TRUSTED_KEYS ? JSON.parse(env.ERGOSPHERE_TRUSTED_KEYS) as TrustedKey[] : config.trustedKeys,
}).catch((error) => {
  console.error('[ergosphere-it] The test launcher failed.', error)
  app.exit(1)
})
