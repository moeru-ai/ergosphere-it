// Local demo on macOS: builds 1.0.0 and 1.1.0, makes a Sparkle appcast with a delta, registers 1.1.0 as the
// installer of the channel, serves both, and starts 1.0.0. The app shows the update dialog. Press Install, and Sparkle
// downloads the delta and relaunches the app as 1.1.0. Press Ctrl+C to stop.
//
// Usage: node scripts/demo.ts [--dir <dir>] [--port 4200] [--no-launch]
//
// --dir holds the keys, the builds, the served files, and the installed app. Each run empties it. Keep it outside the
// repository. The default is a new temporary directory.

import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { argv, env, exit, platform } from 'node:process'
import { parseArgs } from 'node:util'

import { createKeyPair } from '@ergosphere-it/protocol'

import { registerInstaller } from './register-installer.ts'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
    'dir': { type: 'string' },
    'no-launch': { default: false, type: 'boolean' },
    'port': { default: '4200', type: 'string' },
  },
})

if (platform !== 'darwin') {
  console.error('Sparkle runs only on macOS.')
  exit(1)
}

const root = resolve(import.meta.dirname, '..')
// The default is outside the repository: the packaged app has package.json files that pnpm takes as workspaces.
const work = resolve(options.dir ?? mkdtempSync(join(tmpdir(), 'ergosphere-sparkle-')))
const origin = `http://127.0.0.1:${options.port}`
// The package exports no package.json, so this goes up from dist/index.js.
const sparkleRoot = resolve(dirname(createRequire(import.meta.url).resolve('electron-sparkle-updater')), '..')
const product = 'ErgosphereSparkle'
const versions = ['1.0.0', '1.1.0']

rmSync(work, { force: true, recursive: true })
mkdirSync(join(work, 'serve/sparkle'), { recursive: true })

// The update key of ergosphere-it signs the installer release and the channel. The EdDSA key of Sparkle signs each
// archive and delta in the appcast. Sparkle keys are a raw 32-byte seed and a raw 32-byte public key.
const { signingKey, trustedKey } = await createKeyPair()
const sparkleKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
const sparkleSeed = Buffer.from(await crypto.subtle.exportKey('pkcs8', sparkleKey.privateKey)).subarray(-32)
const sparklePublic = Buffer.from(await crypto.subtle.exportKey('raw', sparkleKey.publicKey))
const sparkleKeyFile = join(work, 'sparkle-private-key.txt')
await import('node:fs/promises').then(({ writeFile }) => writeFile(sparkleKeyFile, sparkleSeed.toString('base64'), { mode: 0o600 }))

const buildEnv = {
  ...env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ERGO_FEED_URL: `${origin}/bucket`,
  ERGO_PUBLIC_KEY: `ed25519:${trustedKey.publicKey}`,
  SPARKLE_ED_PUBLIC_KEY: sparklePublic.toString('base64'),
}
function run(command: string, args: string[], extra: Record<string, string> = {}) {
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

console.info('\n== Generate the appcast')
run(join(sparkleRoot, 'native/vendor/bin/generate_appcast'), [join(work, 'serve/sparkle'), '--ed-key-file', sparkleKeyFile, '--download-url-prefix', `${origin}/sparkle/`])
// generate_appcast names the appcast after SUFeedURL. The launcher gives Sparkle the URL of the installer release.
renameSync(join(work, 'serve/sparkle/unused-appcast.xml'), join(work, 'serve/sparkle/appcast.xml'))

const latest = versions.at(-1)!
const releaseId = await registerInstaller({
  appcastFile: join(work, 'serve/sparkle/appcast.xml'),
  appcastUrl: `${origin}/sparkle/appcast.xml`,
  bucketDir: join(work, 'serve/bucket'),
  channel: 'stable',
  outDir: join(work, `out-${latest}`),
  signingKey: `ed25519:${signingKey.privateKey}`,
})
console.info(`Registered installer ${releaseId} (${latest}) on stable.`)

const types: Record<string, string> = { '.json': 'application/json', '.xml': 'application/xml' }
createServer((request, response) => {
  const path = normalize(join(work, 'serve', decodeURIComponent(new URL(request.url ?? '/', origin).pathname)))
  if (!path.startsWith(join(work, 'serve')) || !existsSync(path) || !extname(path)) {
    response.writeHead(404).end()
    return
  }
  console.info(`GET ${request.url}`)
  response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path))
}).listen(Number(options.port), '127.0.0.1')

const installed = join(work, `installed/${product}.app`)
mkdirSync(dirname(installed), { recursive: true })
const packaged = readdirSync(join(work, `dist-${versions[0]}`)).find(name => name.startsWith('mac'))!
execFileSync('ditto', [join(work, `dist-${versions[0]}`, packaged, `${product}.app`), installed])

console.info(`\nServing ${origin}. Installed ${versions[0]} at ${installed}.`)
if (options['no-launch'])
  console.info(`Start it with: open "${installed}"`)
else
  spawn(join(installed, `Contents/MacOS/${product}`), [], { detached: true, stdio: 'ignore' }).unref()
console.info(`Press Install in the update dialog. Sparkle downloads the delta and relaunches the app as ${latest}.`)
