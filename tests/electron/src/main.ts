// The bundle main of the test build. It adds test hooks around the main of the example, then loads it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, pid } from 'node:process'
import { fileURLToPath } from 'node:url'

import { activeBundle, updater } from '@ergosphere-it/electron/main'
import { app, BrowserWindow, protocol, utilityProcess } from 'electron'

import assetPath from './entries/asset.txt?asset'
// A file of the public directory, `resources`, as apps import their icons.
import publicAssetPath from '../resources/public-asset.txt?asset'
import forkPath from './entries/fork?modulePath'
import createWorker from './entries/worker?nodeWorker'

// A crash variant throws at start, so the launcher falls back to an earlier bundle.
if (__TEST_CRASH__)
  throw new Error(`test bundle main crash (tag ${__TEST_MAIN_TAG__})`)

/** Writes a test event to the event log of the launcher, in the same form. */
function logEvent(event: Record<string, unknown>): void {
  if (env.ERGOSPHERE_IT_LOG)
    appendFileSync(env.ERGOSPHERE_IT_LOG, `${JSON.stringify({ ...event, pid, time: Date.now() })}\n`)
}

// The main tag is part of the main code. A new tag changes main, so the update needs a restart.
logEvent({ mainTag: __TEST_MAIN_TAG__, releaseId: activeBundle.releaseId, type: 'bundle-main' })

// A real app calls APIs that work only before the app is ready, at the top level of main, as AIRI and LobeHub do. The
// launcher must start main before ready.
let preReady = 'ok'
try {
  protocol.registerSchemesAsPrivileged([{ privileges: { secure: true, standard: true }, scheme: 'ergosphere-test' }])
  app.commandLine.appendSwitch('ergosphere-test-switch')
}
catch (error) {
  preReady = error instanceof Error ? error.message : String(error)
}

// The test plays the user: it applies every update that is ready, as a click on the button does, and closes a
// rollback notice after it was shown.
if (env.ERGOSPHERE_E2E_APPLY === '1') {
  updater.onStatus((status) => {
    if (status.status === 'ready')
      void updater.applyUpdate()
    if (status.status === 'rolled-back')
      setTimeout(() => void updater.dismissRollback(), 500)
  })
}

app.on('browser-window-created', (_event, window) => {
  // Windows stay hidden unless a person watches the run.
  if (env.ERGOSPHERE_SHOW_WINDOW !== '1')
    window.show = () => {}

  // The test shim of the page logs this line when the page calls markBundleHealthy().
  window.webContents.on('console-message', ({ message }) => {
    if (message !== '[ergosphere-test] mounted')
      return

    logEvent({ releaseId: activeBundle.releaseId, type: 'page-mounted', url: window.webContents.getURL(), version: activeBundle.version })
    const captureDir = env.ERGOSPHERE_CAPTURE_DIR
    if (captureDir) {
      setTimeout(async () => {
        const image = await window.webContents.capturePage()
        mkdirSync(captureDir, { recursive: true })
        writeFileSync(join(captureDir, `${Date.now()}-${activeBundle.releaseId}-${activeBundle.version}.png`), image.toPNG())
      }, 300)
    }
  })
})

// A second window that the app loads itself, as AIRI does, on a route that changes after load. A page-only update must
// move it to the new bundle on the route that it shows then.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: activeBundle.preload, sandbox: true } })
  await window.loadURL(activeBundle.pageUrl({ hash: '/second' }))
  await window.webContents.executeJavaScript(`location.hash = '#/second-moved'`)
})

// Every kind of entry and asset that electron-vite builds for main and preload must be in the bundle, so a downloaded
// bundle finds them as the bundle of the installer does.
void app.whenReady().then(async () => {
  const reply = (path: string) => new Promise<string>((resolve, reject) => {
    const child = utilityProcess.fork(path)
    child.once('message', (message: string) => {
      child.kill()
      resolve(message)
    })
    child.once('exit', code => reject(new Error(`${path} exited with ${code}`)))
    child.postMessage('ping')
  })
  const check = async (run: () => boolean | Promise<boolean>) => {
    try {
      return await run()
    }
    catch {
      return false
    }
  }
  const extraPreload = await check(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload: activeBundle.preloadOf('extra'), sandbox: true } })
    await window.loadURL('data:text/html,<p>extra</p>')
    const loaded = await window.webContents.executeJavaScript('window.ergosphereExtraPreload?.loaded === true') as boolean
    window.destroy()

    return loaded
  })
  logEvent({
    // git can check the file out with CRLF line endings on Windows.
    asset: await check(() => readFileSync(assetPath, 'utf8').trim() === 'asset of main'),
    extraPreload,
    modulePath: await check(async () => await reply(forkPath) === 'fork'),
    nodeWorker: await check(() => new Promise<boolean>((resolve) => {
      const worker = createWorker({})
      worker.once('message', message => resolve(message === 'worker'))
      worker.once('error', () => resolve(false))
    })),
    preReady,
    publicAsset: await check(() => readFileSync(publicAssetPath, 'utf8').trim() === 'public asset of main'),
    releaseId: activeBundle.releaseId,
    sync: await check(async () => existsSync(fileURLToPath(new URL('./sync.mjs', import.meta.url))) && await reply(fileURLToPath(new URL('./sync.mjs', import.meta.url))) === 'sync'),
    type: 'bundle-files',
  })
})

// Many apps wait for ready at the top level of main. The launcher waits for main, and Electron for the launcher, so the
// launcher must stop waiting here, or the app never gets ready.
// eslint-disable-next-line antfu/no-top-level-await -- The test needs a top-level await of ready, as apps write it.
await app.whenReady()

void import('../../../examples/electron-app/src/main/index')
