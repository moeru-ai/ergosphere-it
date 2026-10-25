// Renders the README banners, in the dark and the light theme, as WebP in docs/assets/banners.
// It builds the page and serves it with vite preview. Still banners are screenshots of ?capture=<scene> from headless
// Chrome at 2x, converted with cwebp. The hero and the machine are animated: Chrome draws one frame of the loop at a
// time through the DevTools protocol, and img2webp joins the frames into a looping, lossless WebP.
//
//   pnpm -F @ergosphere-it/docs-visuals banners
//
// CHROME points to another Chrome binary. cwebp and img2webp must be on PATH (brew install webp).

import type { CaptureScene } from '../src/capture.ts'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build, preview } from 'vite'

import { CAPTURE_SIZES } from '../src/capture.ts'
import { LOOP } from '../src/hero/timeline.ts'
import { ROUND } from '../src/how/timeline.ts'

// Async, so the preview server in this process keeps answering while Chrome loads the page.
const run = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '..', 'assets', 'banners')
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const THEMES = ['dark', 'light'] as const

/** Still banners: the file name, the scene, and the query that freezes it. */
const STILLS: { file: string, query: string, scene: CaptureScene }[] = [
  { file: 'setup', query: 'capture=setup', scene: 'setup' },
  { file: 'features', query: 'capture=features', scene: 'features' },
  // The figures of the README sections.
  ...(['keys', 'build', 'windows', 'prompt', 'host', 'publish'] as const).map(name => ({
    file: `figure-${name}`,
    query: `capture=figure-${name}`,
    scene: `figure-${name}` as const,
  })),
]

/** Animated banners: the hook that draws one moment, how long one loop is, and how many frames a second. */
const ANIMATED: { duration: number, file: string, fps: number, hook: string, query: string, scene: CaptureScene }[] = [
  { duration: LOOP, file: 'hero', fps: 15, hook: '__heroAt', query: 'capture=hero', scene: 'hero' },
  // Both rounds: one keeps the new bundle, one sends it back.
  { duration: 2 * ROUND, file: 'how-it-works', fps: 12, hook: '__howAt', query: 'capture=how&at=0', scene: 'how' },
]

// A built page, not the dev server: the dev server can reload the page while it optimizes dependencies,
// and headless Chrome then never finishes.
const configFile = join(root, 'vite.config.ts')
await build({ configFile, logLevel: 'error', root })
const server = await preview({ configFile, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 }, root })
const address = server.httpServer.address()
if (!address || typeof address === 'string')
  throw new Error('The Vite server has no port.')
const origin = `http://127.0.0.1:${address.port}`

const work = mkdtempSync(join(tmpdir(), 'ergosphere-banners-'))
mkdirSync(out, { recursive: true })

/** A minimal client of the Chrome DevTools protocol over the WebSocket that Node has built in. */
class DevTools {
  private next = 0
  private readonly pending = new Map<number, { reject: (error: Error) => void, resolve: (value: any) => void }>()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { error?: { message: string }, id?: number, result?: unknown }
      const waiting = message.id === undefined ? undefined : this.pending.get(message.id)
      if (!waiting)
        return
      this.pending.delete(message.id!)
      if (message.error)
        waiting.reject(new Error(message.error.message))
      else
        waiting.resolve(message.result)
    })
  }

  static async connect(url: string): Promise<DevTools> {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new DevTools(socket)
  }

  close(): void {
    this.socket.close()
  }

  /** Runs an expression in the page and waits for it when it is a promise. */
  async evaluate(expression: string): Promise<unknown> {
    const { exceptionDetails, result } = await this.send('Runtime.evaluate', { awaitPromise: true, expression, returnByValue: true })
    if (exceptionDetails)
      throw new Error(`The page threw: ${JSON.stringify(exceptionDetails)}`)
    return result.value
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.next
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { reject, resolve }))
  }
}

async function animated({ duration, file, fps, hook, query, scene }: typeof ANIMATED[number], theme: string): Promise<void> {
  const { height, width } = CAPTURE_SIZES[scene]
  const profile = join(work, `profile-${file}-${theme}`)
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    // Chrome writes the port that it picked into the profile.
    let port: string | undefined
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100)
      try {
        port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
      }
      catch {}
    }
    if (!port)
      throw new Error('Chrome did not open its DevTools port.')

    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string, webSocketDebuggerUrl: string }[]
    const page = targets.find(t => t.type === 'page')
    if (!page)
      throw new Error('Chrome has no page.')
    const devtools = await DevTools.connect(page.webSocketDebuggerUrl)

    await devtools.send('Emulation.setDeviceMetricsOverride', { deviceScaleFactor: 1, height, mobile: false, width })
    // Transparent around the rounded corners of the banner.
    await devtools.send('Emulation.setDefaultBackgroundColorOverride', { color: { a: 0, b: 0, g: 0, r: 0 } })
    await devtools.send('Page.enable')
    await devtools.send('Page.navigate', { url: `${origin}/?${query}&theme=${theme}` })
    await devtools.evaluate(`new Promise(async (resolve) => {
      while (!window.${hook}) await new Promise(r => setTimeout(r, 50))
      await document.fonts.ready
      resolve(true)
    })`)

    const frames: string[] = []
    const count = Math.round(duration * fps)
    for (let i = 0; i < count; i++) {
      await devtools.evaluate(`window.${hook}(${i / fps}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
      const { data } = await devtools.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
      const frame = join(work, `${file}-${theme}-${String(i).padStart(4, '0')}.png`)
      writeFileSync(frame, Buffer.from(data, 'base64'))
      frames.push(frame)
    }
    devtools.close()

    const webp = join(out, `${file}-${theme}.webp`)
    await run('img2webp', ['-loop', '0', '-lossless', '-q', '100', '-m', '4', '-d', String(Math.round(1000 / fps)), ...frames, '-o', webp], { maxBuffer: 1 << 26 })
    console.info(webp)
  }
  finally {
    browser.kill()
  }
}

async function still(file: string, query: string, scene: CaptureScene, theme: string): Promise<void> {
  const { height, width } = CAPTURE_SIZES[scene]
  const png = join(work, `${file}-${theme}.png`)
  await run(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    // Transparent around the rounded corners of the banner.
    '--default-background-color=00000000',
    `--window-size=${width},${height}`,
    // Gives fonts and highlighted code time to arrive before the screenshot.
    '--virtual-time-budget=4000',
    `--user-data-dir=${join(work, 'profile')}`,
    `--screenshot=${png}`,
    `${origin}/?${query}&theme=${theme}`,
  ], { timeout: 60_000 })
  const webp = join(out, `${file}-${theme}.webp`)
  await run('cwebp', ['-quiet', '-q', '92', png, '-o', webp])
  console.info(webp)
}

try {
  for (const theme of THEMES) {
    for (const a of ANIMATED)
      await animated(a, theme)
    for (const s of STILLS)
      await still(s.file, s.query, s.scene, theme)
  }
}
finally {
  await server.close()
  rmSync(work, { force: true, recursive: true })
}
