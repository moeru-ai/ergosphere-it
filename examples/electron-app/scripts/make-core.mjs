// Writes one version of the example core.
//
// Usage: node scripts/make-core.mjs <outDir> --label v2 [--main-tag 1] [--asset-mb 0] [--crash] [--no-mount]
//
// --label changes only the page, so the change reloads in place.
// --main-tag changes the main code, so the change needs a restart.
// --asset-mb adds a page asset of that size. Its bytes depend on the label, so each page update downloads it again.
// --crash makes the main code throw. --no-mount makes the page never report healthy.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv } from 'node:process'
import { parseArgs } from 'node:util'

import { sumBy } from 'es-toolkit'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  args: argv.slice(2),
  options: {
    'asset-mb': { default: '0', type: 'string' },
    'crash': { default: false, type: 'boolean' },
    'label': { default: 'v1', type: 'string' },
    'main-tag': { default: '1', type: 'string' },
    'no-mount': { default: false, type: 'boolean' },
  },
})

const out = positionals[0]
/** Pseudo-random bytes from a seed, so one label always gives the same asset. */
function seededBytes(seed, size) {
  const bytes = new Uint8Array(size)
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0 || 1
  for (let index = 0; index < size; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state & 0xFF
  }

  return bytes
}

function write(path, content) {
  mkdirSync(join(out, path, '..'), { recursive: true })
  writeFileSync(join(out, path), content)
}

const assetBytes = Math.round(Number(values['asset-mb']) * 1024 * 1024)
if (assetBytes > 0)
  write('renderer/assets/blob.bin', seededBytes(values.label, assetBytes))

write('main/index.mjs', `// main tag ${values['main-tag']}
${values.crash ? `throw new Error('example core main crash (tag ${values['main-tag']})')\n` : ''}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, pid } from 'node:process'

import { getCore } from '@ergosphere-it/driver-electron/core'
import { app, BrowserWindow, ipcMain } from 'electron'

const core = getCore()
const MAIN_TAG = ${JSON.stringify(values['main-tag'])}

function log(event) {
  if (env.ERGOSPHERE_EVENT_LOG)
    appendFileSync(env.ERGOSPHERE_EVENT_LOG, JSON.stringify({ time: Date.now(), pid, ...event }) + '\\n')
}

log({ type: 'core-main', seq: core.info.seq, kind: core.info.kind, mainTag: MAIN_TAG })

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    show: env.ERGOSPHERE_SHOW_WINDOW === '1',
    title: 'ergosphere-it example',
    webPreferences: { preload: core.resolve('preload', 'index.cjs'), sandbox: true, contextIsolation: true },
  })
  const loadPage = () => window.loadFile(core.resolve('renderer', 'index.html'), {
    query: { seq: String(core.info.seq), kind: core.info.kind, pid: String(pid), mainTag: MAIN_TAG },
  })

  // The page shows the update notice. It gets every status change and asks main to apply the update.
  const sendStatus = status => !window.isDestroyed() && window.webContents.send('example:status', status)
  core.updater.onStatus(sendStatus)
  window.webContents.on('did-finish-load', () => sendStatus(core.updater.status))
  ipcMain.handle('example:apply', () => core.updater.apply())

  ipcMain.on('example:mounted', (_event, page) => {
    log({ type: 'page-mounted', seq: core.info.seq, ...page })
    core.markHealthy()
    if (env.ERGOSPHERE_CAPTURE_DIR) {
      setTimeout(async () => {
        const image = await window.webContents.capturePage()
        mkdirSync(env.ERGOSPHERE_CAPTURE_DIR, { recursive: true })
        writeFileSync(join(env.ERGOSPHERE_CAPTURE_DIR, Date.now() + '-core' + core.info.seq + '-' + page.label + '.png'), image.toPNG())
      }, 300)
    }
  })

  loadPage()
  core.onReload((info) => {
    log({ type: 'page-reload', seq: info.seq })
    loadPage()
  })

  const interval = Number(env.ERGOSPHERE_CHECK_MS ?? 0)
  if (interval > 0) {
    const tick = () => core.updater.check().catch(error => log({ type: 'check-error', error: String(error) }))
    setInterval(tick, interval)
  }
})

app.on('window-all-closed', () => app.quit())
`)

write('preload/index.cjs', `const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('example', {
  apply: () => ipcRenderer.invoke('example:apply'),
  mounted: page => ipcRenderer.send('example:mounted', page),
  onStatus: listener => ipcRenderer.on('example:status', (_event, status) => listener(status)),
})
`)

const hue = sumBy([...values.label], char => char.charCodeAt(0) * 37) % 360

write('renderer/index.html', `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ergosphere-it example ${values.label}</title>
<style>
  body { font-family: system-ui; margin: 0; height: 100vh; display: grid; place-items: center; color: #fff; background: hsl(${hue} 55% 42%); overflow: hidden; }
  main { text-align: center; }
  h1 { font-size: 72px; margin: 0; }
  #info { font: 16px ui-monospace, monospace; opacity: .85; }
  .toast { position: fixed; left: 16px; bottom: 16px; width: 300px; background: rgba(20, 20, 24, .92); color: #fff; border-radius: 12px; padding: 12px 14px; box-shadow: 0 8px 30px rgba(0, 0, 0, .3); font-size: 13px; display: none; }
  .toast.show { display: block; }
  .toast.bad { background: rgba(150, 30, 30, .95); }
  .toast .title { font-weight: 600; margin-bottom: 6px; }
  .bar { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .2); overflow: hidden; margin: 8px 0 4px; }
  .bar > div { height: 100%; width: 0; background: #7cf; transition: width .15s; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  button { font: inherit; border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer; background: rgba(255, 255, 255, .15); color: #fff; }
  button.primary { background: #fff; color: #111; }
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); display: none; place-items: center; }
  .backdrop.show { display: grid; }
  .dialog { width: 340px; background: #fff; color: #111; border-radius: 14px; padding: 20px; box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
  .dialog h2 { margin: 0 0 6px; font-size: 18px; }
  .dialog p { margin: 0 0 16px; color: #555; font-size: 14px; }
  .dialog .row { justify-content: flex-end; }
  .dialog button { background: #eee; color: #111; }
  .dialog button.primary { background: #4b45c2; color: #fff; }
</style>
</head>
<body>
  <main>
    <div style="font-size: 14px; opacity: .8">page</div>
    <h1>${values.label}</h1>
    <p id="info"></p>
  </main>

  <div class="toast" id="toast">
    <div class="row"><span class="title" id="toast-title"></span><button id="toast-close" title="Dismiss">×</button></div>
    <div id="toast-body"></div>
    <div class="bar" id="toast-bar"><div id="toast-progress"></div></div>
    <div class="row"><span id="toast-detail" style="opacity: .7"></span><button class="primary" id="toast-apply">Apply</button></div>
  </div>

  <div class="backdrop" id="backdrop">
    <div class="dialog">
      <h2 id="dialog-title"></h2>
      <p id="dialog-body"></p>
      <div class="row"><button id="dialog-later">Later</button><button class="primary" id="dialog-apply"></button></div>
    </div>
  </div>

  <script>
    const query = new URLSearchParams(location.search)
    document.getElementById('info').textContent = 'core ' + query.get('seq') + ' (' + query.get('kind') + ') · main tag ' + query.get('mainTag') + ' · pid ' + query.get('pid')

    const $ = id => document.getElementById(id)
    const mb = bytes => (bytes / 1048576).toFixed(1) + ' MB'
    let readySeq
    let dismissed

    function toast({ title, body = '', progress, detail = '', apply = false, bad = false }) {
      $('toast').className = 'toast show' + (bad ? ' bad' : '')
      $('toast-title').textContent = title
      $('toast-body').textContent = body
      $('toast-bar').style.display = progress === undefined ? 'none' : 'block'
      $('toast-progress').style.width = Math.round((progress ?? 0) * 100) + '%'
      $('toast-detail').textContent = detail
      $('toast-apply').style.display = apply ? 'inline-block' : 'none'
    }
    const hideToast = () => { $('toast').className = 'toast' }

    function showDialog(status) {
      $('dialog-title').textContent = status.version + ' is ready'
      $('dialog-body').textContent = status.activation === 'reload'
        ? 'Only the page changed. The page reloads, and the app keeps running.'
        : 'The app code changed. The app restarts to finish the update.'
      $('dialog-apply').textContent = status.activation === 'reload' ? 'Reload now' : 'Restart now'
      $('backdrop').className = 'backdrop show'
    }

    function readyToast(status) {
      toast({ title: 'Update ready', body: status.version + ' is downloaded.', apply: true, detail: status.activation === 'reload' ? 'Reload to update' : 'Restart to update' })
    }

    window.example.onStatus((status) => {
      if (status.state === 'downloading') {
        const progress = status.totalBytes ? status.downloadedBytes / status.totalBytes : 1
        toast({ title: 'Downloading update', body: status.version, progress, detail: mb(status.downloadedBytes) + ' / ' + mb(status.totalBytes) })
      }
      else if (status.state === 'ready') {
        if (readySeq !== status.seq) {
          readySeq = status.seq
          readyToast(status)
          showDialog(status)
        }
      }
      else if (status.state === 'applying') {
        $('backdrop').className = 'backdrop'
        toast({ title: status.activation === 'reload' ? 'Reloading…' : 'Restarting…', body: status.version })
      }
      else if (status.state === 'rolled-back') {
        const key = status.from + '-' + status.to
        if (dismissed !== key) {
          toast({ title: 'Update failed', body: 'Core ' + status.from + ' did not work, so the app went back to core ' + status.to + '.', detail: status.reason, bad: true })
          $('toast-close').onclick = () => { dismissed = key; hideToast() }
        }
      }
      else if (status.state === 'error') {
        toast({ title: 'Update error', body: status.message, bad: true })
      }
      else {
        hideToast()
      }
    })

    const apply = () => { $('backdrop').className = 'backdrop'; window.example.apply() }
    $('dialog-apply').onclick = apply
    $('toast-apply').onclick = apply
    $('dialog-later').onclick = () => { $('backdrop').className = 'backdrop' }
    $('toast-close').onclick = hideToast

    ${values['no-mount'] ? '// This page never reports healthy.' : `window.example.mounted({ label: ${JSON.stringify(values.label)}, mainTag: ${JSON.stringify(values['main-tag'])} })`}
  </script>
</body>
</html>
`)
