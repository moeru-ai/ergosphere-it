// The shell entry of the example app. It only boots the selected core.
// Everything else, including windows, lives in the core and can be updated over the air.

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { argv, env, pid } from 'node:process'
import { fileURLToPath } from 'node:url'

import { Shell } from '@ergosphere-it/driver-electron/shell'
import { app } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

// The host API of this shell. A core declares the range of shells it runs on.
const HOST_API = 1

if (env.ERGOSPHERE_USER_DATA)
  app.setPath('userData', env.ERGOSPHERE_USER_DATA)

const eventLog = env.ERGOSPHERE_EVENT_LOG
function log(event) {
  if (eventLog)
    appendFileSync(eventLog, `${JSON.stringify({ pid, time: Date.now(), ...event })}\n`)
}

log({ argv: argv.slice(1), type: 'shell-start' })

new Shell({
  applyMode: env.ERGOSPHERE_APPLY_MODE === 'auto' ? 'auto' : 'prompt',
  baseUrl: env.ERGOSPHERE_BASE_URL ?? 'http://127.0.0.1:4100',
  bootHealthTimeoutMs: Number(env.ERGOSPHERE_BOOT_HEALTH_MS ?? 60000),
  // core.json is the `builtin` descriptor of the release that the installer ships.
  builtin: { ...JSON.parse(readFileSync(join(appRoot, 'core.json'), 'utf8')), dir: join(appRoot, 'core') },
  entryUrl: import.meta.url,
  healthTimeoutMs: Number(env.ERGOSPHERE_HEALTH_MS ?? 15000),
  hostApi: HOST_API,
  onEvent: log,
  product: 'example',
  trustedKeys: [JSON.parse(readFileSync(join(here, 'trusted-key.json'), 'utf8'))],
}).start().catch((error) => {
  log({ error: String(error?.stack ?? error), type: 'shell-error' })
  console.error(error)
  app.exit(1)
})
