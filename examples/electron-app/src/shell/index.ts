// The shell entry of the example app. It only boots the selected core.
// Everything else, including windows, lives in the core and can be updated over the air.

import type { ExampleEvent } from '../events'

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { argv, env, pid } from 'node:process'
import { fileURLToPath } from 'node:url'

import { Shell } from '@ergosphere-it/driver-electron/shell'
import { Format, LogLevel, setGlobalFormat, setGlobalHookPostLog, setGlobalLogLevel, useLogg } from '@guiiai/logg'
import { app } from 'electron'

// The host API of this shell. A core declares the range of shells it runs on.
const HOST_API = 1

// `out/shell/index.mjs` is next to `out/core`, the builtin core.
const out = join(dirname(fileURLToPath(import.meta.url)), '..')

if (env.ERGOSPHERE_USER_DATA)
  app.setPath('userData', env.ERGOSPHERE_USER_DATA)

// The shell sets up logging for the whole process. The core main uses the same logg module, so it shares this setup.
setGlobalFormat(Format.Pretty)
setGlobalLogLevel(LogLevel.Log)
if (env.ERGOSPHERE_LOG_FILE) {
  const file = env.ERGOSPHERE_LOG_FILE
  setGlobalHookPostLog(entry => appendFileSync(file, `${JSON.stringify({ ...entry, pid })}\n`))
}

const log = useLogg('shell').useGlobalConfig()
const logEvent = (event: ExampleEvent) => log.withFields({ event }).log(event.type)

logEvent({ argv: argv.slice(1), type: 'shell-start' })

async function start(): Promise<void> {
  if (!__EXAMPLE_TRUSTED_KEY__)
    throw new Error('This shell has no trusted key. Build it with EXAMPLE_TRUSTED_KEY.')

  await new Shell({
    applyMode: env.ERGOSPHERE_APPLY_MODE === 'auto' ? 'auto' : 'prompt',
    baseUrl: env.ERGOSPHERE_BASE_URL ?? 'http://127.0.0.1:4100',
    bootHealthTimeoutMs: Number(env.ERGOSPHERE_BOOT_HEALTH_MS ?? 60_000),
    // core.json is the `builtin` descriptor of the release that the installer ships.
    builtin: { ...JSON.parse(readFileSync(join(out, 'core.json'), 'utf8')), dir: join(out, 'core') },
    entryUrl: import.meta.url,
    healthTimeoutMs: Number(env.ERGOSPHERE_HEALTH_MS ?? 15_000),
    hostApi: HOST_API,
    onEvent: logEvent,
    product: 'example',
    trustedKeys: [__EXAMPLE_TRUSTED_KEY__],
  }).start()
}

start().catch((error) => {
  log.withError(error).error('The shell could not start the builtin core.')
  app.exit(1)
})
