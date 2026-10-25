// Builds two packaged versions of the Sparkle example, and the update tree that takes one to the other.

import type { Server } from 'node:http'

import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { arch, env, execPath } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { createKeyPair } from '@ergosphere-it/protocol'

const example = resolve(import.meta.dirname, '../../../examples/electron-sparkle-app')
const exampleRequire = createRequire(join(example, 'package.json'))
// electron-sparkle-updater exports no package.json, so this goes up from dist/index.js.
const sparkleRoot = resolve(dirname(exampleRequire.resolve('electron-sparkle-updater')), '..')
// pnpm links the bin of a workspace package only when its file exists at install time, which is before the build in a
// fresh clone. So the scripts run the built CLI file itself.
const cli = join(dirname(exampleRequire.resolve('@ergosphere-it/electron/package.json')), 'dist/cli.mjs')
const product = 'ErgosphereSparkle'

export const versions = ['1.0.0', '1.1.0'] as const

export interface Releases {
  /** The installed app, which is the older version. */
  app: string
  executable: string
  /** Paths that the server served, in order. */
  served: string[]
  server: Server
}

export function codesignPasses(app: string): boolean {
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' })

    return true
  }
  catch {
    return false
  }
}

/**
 * Builds and packages both versions, makes the appcast with a delta, registers the newer version as the installer of
 * the `stable` channel, serves the files on `port`, and installs the older version in `work`.
 *
 * `work` is emptied first. It must be outside the repository: the packaged app has package.json files that pnpm takes
 * as workspaces.
 */
export async function prepareReleases({ port, work = mkdtempSync(join(tmpdir(), 'ergosphere-sparkle-')) }: { port: number, work?: string }): Promise<Releases> {
  const origin = `http://127.0.0.1:${port}`
  rmSync(work, { force: true, recursive: true })
  mkdirSync(join(work, 'serve/sparkle'), { recursive: true })

  // The key of ergosphere-it signs the installer release and the channel. The EdDSA key of Sparkle signs each archive
  // and delta in the appcast. A Sparkle key is a raw 32-byte seed, and its public key is the raw 32-byte key.
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
    ERGO_PUBLIC_KEY: createPublicKey({ format: 'der', key: Buffer.from(trustedKey.publicKey, 'base64'), type: 'spki' }).export({ format: 'pem', type: 'spki' }),
    ERGOSPHERE_IT_SIGNING_KEY: createPrivateKey({ format: 'der', key: Buffer.from(signingKey.privateKey, 'base64'), type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }),
    SPARKLE_ED_PUBLIC_KEY: sparklePublic.toString('base64'),
  }
  const run = (command: string, args: string[], extra: Record<string, string> = {}) => {
    execFileSync(command, args, { cwd: example, env: { ...buildEnv, ...extra }, stdio: 'inherit' })
  }

  if (!existsSync(join(sparkleRoot, 'native/build/Release/sparkle_bridge.node')))
    run('pnpm', ['exec', 'electron-sparkle-updater', 'rebuild'])

  for (const version of versions) {
    console.info(`\n== Build ${version}`)
    run('pnpm', ['exec', 'electron-vite', 'build'], { ERGOSPHERE_IT_VERSION: version })
    cpSync(join(example, 'out'), join(work, `out-${version}`), { recursive: true })
    run('pnpm', ['exec', 'electron-builder', '--mac', '--publish', 'never', '--config', 'electron-builder.config.ts', `-c.extraMetadata.version=${version}`, `-c.directories.output=${join(work, `dist-${version}`)}`])
    const zip = readdirSync(join(work, `dist-${version}`)).find(name => name.endsWith('.zip'))!
    copyFileSync(join(work, `dist-${version}`, zip), join(work, 'serve/sparkle', zip))
  }

  console.info('\n== Generate the appcast, and register the installer')
  run(join(sparkleRoot, 'native/vendor/bin/generate_appcast'), [join(work, 'serve/sparkle'), '--ed-key-file', sparkleKeyFile, '--download-url-prefix', `${origin}/sparkle/`])
  // generate_appcast names the appcast after SUFeedURL. The installer release keeps its own copy anyway.
  renameSync(join(work, 'serve/sparkle/unused-appcast.xml'), join(work, 'appcast.xml'))
  run(execPath, [
    cli,
    'register',
    'installer',
    '--store',
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
    join(work, `out-${versions[1]}`),
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
  }).listen(port, '127.0.0.1')

  const app = join(work, `installed/${product}.app`)
  mkdirSync(dirname(app), { recursive: true })
  const packaged = readdirSync(join(work, `dist-${versions[0]}`)).find(name => name.startsWith('mac'))!
  execFileSync('ditto', [join(work, `dist-${versions[0]}`, packaged, `${product}.app`), app])
  console.info(`\nServing ${origin}. Installed ${versions[0]} at ${app}.`)

  return { app, executable: join(app, `Contents/MacOS/${product}`), served, server }
}

/** Waits until the page shows that the installer is ready, then presses its Install button. */
export async function pressInstall(debugPort: number): Promise<boolean> {
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
        const button = document.getElementById('apply')
        button.click()
        return 'clicked ' + button.textContent
      })()`)
      console.info(`page: ${String(result)}`)
      if (String(result).startsWith('clicked'))
        return true
    }
    catch {
      // The page is not up yet.
    }
  }

  return false
}

export function versionOnDisk(app: string): string | undefined {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]).toString().trim()
  }
  catch {
    // Sparkle moves the app while it installs.
    return undefined
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
