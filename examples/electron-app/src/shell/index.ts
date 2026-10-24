// The shell entry of the example app: the part that only a full installer updates.
// It boots the core that the update client selects. Windows and everything else live in the core.

import type { ExampleEvent } from '../events'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

import electronUpdater from 'electron-updater'

import { createElectronUpdaterInstaller } from '@ergosphere-it/driver-electron/electron-updater'
import { Shell } from '@ergosphere-it/driver-electron/shell'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { app } from 'electron'

/** The host API of this shell. Increase it when the shell changes what cores use, for example a native module. */
const HOST_API = 1
/** Where the update tree lives, for example an R2 bucket behind a CDN. The demo serves it on this port. */
const UPDATE_URL = 'http://127.0.0.1:4100'

// `out/shell/index.mjs` is next to `out/core`, the builtin core, and `out/core.json`, its descriptor.
const out = join(dirname(fileURLToPath(import.meta.url)), '..')

setGlobalFormat(Format.Pretty)
const log = useLogg('shell').useGlobalConfig()
const logEvent = (event: ExampleEvent) => log.withFields({ event }).log(event.type)

logEvent({ argv: argv.slice(1), type: 'shell-start' })

new Shell({
  baseUrl: UPDATE_URL,
  builtin: { ...JSON.parse(readFileSync(join(out, 'core.json'), 'utf8')), dir: join(out, 'core') },
  entryUrl: import.meta.url,
  hostApi: HOST_API,
  // Full updates of the shell go through electron-updater, the installer that the app already has.
  installer: createElectronUpdaterInstaller(electronUpdater.autoUpdater),
  onEvent: logEvent,
  product: 'example',
  shellSeq: __SHELL_SEQ__,
  trustedKeys: __TRUSTED_KEYS__,
}).start().catch((error) => {
  log.withError(error).error('The shell could not start the builtin core.')
  app.exit(1)
})
