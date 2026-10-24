// Local demo on macOS: builds 1.0.0 and 1.1.0, makes a Sparkle appcast with a delta, registers 1.1.0 with
// `ergosphere-it register installer --sparkle`, serves the files, and starts 1.0.0. The app shows the update dialog.
// Press Install, and Sparkle downloads the delta and opens the app again as 1.1.0. Press Ctrl+C to stop.
//
// Usage: node scripts/demo.ts [--dir <dir>] [--port 4200] [--no-launch] [--verify]
//
// --dir holds the keys, the builds, the served files, and the installed app. Each run empties it. Keep it outside the
// repository. The default is a new temporary directory.
//
// --verify presses Install through the DevTools protocol, checks that the app on disk is 1.1.0 and that Sparkle
// downloaded the delta and not the archive, then stops with exit code 0 or 1. CI runs it.

import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { arch, argv, env, exit, platform } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { createKeyPair } from '@ergosphere-it/protocol'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
    'dir': { type: 'string' },
    'no-launch': { default: false, type: 'boolean' },
    'port': { default: '4200', type: 'string' },
    'verify': { default: false, type: 'boolean' },
  },
})

if (platform !== 'darwin') {
  console.error('Sparkle runs only on macOS.')
  exit(1)
}

const root = resolve(import.meta.dirname, '..')
// The default is outside the repository: the packaged app has package.json files that pnpm takes as workspaces.
const work = resolve(options.dir ?? mkdtempSync(join(tmpdir(), 'ergosphere-sparkle-')))
// The package exports no package.json, so this goes up from dist/index.js.
const sparkleRoot = resolve(dirname(createRequire(import.meta.url).resolve('electron-sparkle-updater')), '..')
const origin = `http://127.0.0.1:${options.port}`
const product = 'ErgosphereSparkle'
const versions = ['1.0.0', '1.1.0'] as const

rmSync(work, { force: true, recursive: true })
mkdirSync(join(work, 'serve/sparkle'), { recursive: true })

// The key of ergosphere-it signs the installer release and the channel. The EdDSA key of Sparkle signs each archive and
// delta in the appcast. A Sparkle key is a raw 32-byte seed, and its public key is the raw 32-byte key.
const { signingKey, trustedKey } = await createKeyPair()
const sparkleKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
const sparkleSeed = Buffer.from(await crypto.subtle.exportKey('pkcs8', sparkleKey.privateKey)).subarray(-32)
const sparklePublic = Buffer.from(await crypto.subtle.exportKey('raw', sparkleKey.publicKey))
const sparkleKeyFile = join(work, 'sparkle-private-key.txt')
writeFileSync(sparkleKeyFile, sparkleSeed.toString('base64'), { mode: 0o600 })

const buildEnv = {
  ...env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ERGO_FEED_URL: `${origin}/bucket`,
  ERGO_PUBLIC_KEY: `ed25519:${trustedKey.publicKey}`,
  SPARKLE_ED_PUBLIC_KEY: sparklePublic.toString('base64'),
  UPDATES_SIGNING_KEY: `ed25519:${signingKey.privateKey}`,
}

function run(command: string, args: string[], extra: Record<string, string> = {}): void {
  execFileSync(command, args, { cwd: root, env: { ...buildEnv, ...extra }, stdio: 'inherit' })
}

if (!existsSync(join(sparkleRoot, 'native/build/Release/sparkle_bridge.node')))
  run('pnpm', ['exec', 'electron-sparkle-updater', 'rebuild'])

for (const version of versions) {
  console.info(`\n== Build ${version}`)
  run('pnpm', ['exec', 'electron-vite', 'build'], { UPDATES_VERSION: version })
  cpSync(join(root, 'out'), join(work, `out-${version}`), { recursive: true })
  run('pnpm', ['exec', 'electron-builder', '--mac', '--publish', 'never', '--config', 'electron-builder.config.ts', `-c.extraMetadata.version=${version}`, `-c.directories.output=${join(work, `dist-${version}`)}`])
  const zip = readdirSync(join(work, `dist-${version}`)).find(name => name.endsWith('.zip'))!
  copyFileSync(join(work, `dist-${version}`, zip), join(work, 'serve/sparkle', zip))
}

console.info('\n== Generate the appcast, and register the installer')
run(join(sparkleRoot, 'native/vendor/bin/generate_appcast'), [join(work, 'serve/sparkle'), '--ed-key-file', sparkleKeyFile, '--download-url-prefix', `${origin}/sparkle/`])
// generate_appcast names the appcast after SUFeedURL. The installer release keeps its own copy anyway.
renameSync(join(work, 'serve/sparkle/unused-appcast.xml'), join(work, 'appcast.xml'))
const latest = versions[1]
run('pnpm', [
  'exec',
  'ergosphere-it',
  'register',
  'installer',
  '--bucket',
  join(work, 'serve/bucket'),
  '--channel',
  'stable',
  '--sparkle',
  `darwin-${arch}=${join(work, 'appcast.xml')}`,
  '--feed-url',
  `${origin}/bucket`,
  '--download-page',
  'https://github.com/moeru-ai/ergosphere-it',
  '--out',
  join(work, `out-${latest}`),
])

const served: string[] = []
const types: Record<string, string> = { '.json': 'application/json', '.xml': 'application/xml' }
const server = createServer((request, response) => {
  const path = normalize(join(work, 'serve', decodeURIComponent(new URL(request.url ?? '/', origin).pathname)))
  if (!path.startsWith(join(work, 'serve')) || !existsSync(path) || !extname(path)) {
    response.writeHead(404).end()

    return
  }
  served.push(request.url ?? '')
  console.info(`GET ${request.url}`)
  response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path))
}).listen(Number(options.port), '127.0.0.1')

const installed = join(work, `installed/${product}.app`)
const executable = join(installed, `Contents/MacOS/${product}`)
mkdirSync(dirname(installed), { recursive: true })
const packaged = readdirSync(join(work, `dist-${versions[0]}`)).find(name => name.startsWith('mac'))!
execFileSync('ditto', [join(work, `dist-${versions[0]}`, packaged, `${product}.app`), installed])
console.info(`\nServing ${origin}. Installed ${versions[0]} at ${installed}.`)

if (options.verify) {
  exit(await verify() ? 0 : 1)
}
else if (options['no-launch']) {
  console.info(`Start it with: open "${installed}"`)
}
else {
  spawn(executable, [], { detached: true, stdio: 'ignore' }).unref()
  console.info(`Press Install in the update dialog. Sparkle downloads the delta and opens the app again as ${latest}.`)
}

function codesignPasses(): boolean {
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', installed], { stdio: 'ignore' })

    return true
  }
  catch {
    return false
  }
}

async function evaluate(url: string, expression: string): Promise<unknown> {
  const socket = new WebSocket(url)
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  try {
    return await new Promise((resolve) => {
      socket.addEventListener('message', event => resolve(JSON.parse(String(event.data)).result?.result?.value), { once: true })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, expression, returnByValue: true } }))
    })
  }
  finally {
    socket.close()
  }
}

/** Waits until the page shows that the installer is ready, then presses its Install button. */
async function pressInstall(debugPort: number): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(1000)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as { type: string, webSocketDebuggerUrl: string }[]
      const page = pages.find(target => target.type === 'page')
      if (!page)
        continue

      const result = await evaluate(page.webSocketDebuggerUrl, `(async () => {
        const { status } = await window.updates.get()
        if (status.status !== 'ready' || status.update.requires !== 'install')
          return status.status
        const button = [...document.querySelectorAll('button')].find(item => /install/i.test(item.textContent))
        button?.click()
        return button ? 'clicked' : 'no button'
      })()`)
      console.info(`page: ${String(result)}`)
      if (result === 'clicked')
        return true
    }
    catch {
      // The page is not up yet.
    }
  }

  return false
}

/** Presses Install as a person would, then checks the app on disk and what Sparkle downloaded. */
async function verify(): Promise<boolean> {
  const debugPort = Number(options.port) + 1
  const app = spawn(executable, [`--remote-debugging-port=${debugPort}`], { stdio: 'ignore' })
  try {
    const clicked = await pressInstall(debugPort)
    // Sparkle quits the app, replaces it, and opens it again.
    for (let attempt = 0; attempt < 60 && versionOnDisk() !== latest; attempt++)
      await delay(1000)

    const downloads = served.filter(path => path.startsWith('/sparkle/'))
    const checks = {
      [`the app on disk is ${latest}`]: versionOnDisk() === latest,
      'Install was pressed': clicked,
      'Sparkle did not download an archive': !downloads.some(path => path.endsWith('.zip')),
      'Sparkle downloaded a delta': downloads.some(path => path.endsWith('.delta')),
      'the app passes codesign --verify': codesignPasses(),
    }
    for (const [name, ok] of Object.entries(checks))
      console.info(`${ok ? 'PASS' : 'FAIL'} ${name}`)

    return Object.values(checks).every(Boolean)
  }
  finally {
    app.kill()
    // Sparkle opened a new process of the app, which is not a child of this script.
    spawn('pkill', ['-f', executable], { stdio: 'ignore' })
    server.close()
  }
}

function versionOnDisk(): string | undefined {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(installed, 'Contents/Info.plist')]).toString().trim()
  }
  catch {
    // Sparkle moves the app while it installs.
    return undefined
  }
}
