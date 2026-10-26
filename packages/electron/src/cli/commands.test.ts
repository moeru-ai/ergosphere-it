import type { BundleManifest, ChannelFile, SigningKey } from '@ergosphere-it/protocol'
import type { BundleObject, Signed } from '@ergosphere-it/publish'

import type { BuildInfo } from '../layout'
import type { PublishProgress } from './commands'

import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

import { contentHash, trustedKeyFromPublicKey, trustedKeyToOpenSsh, verifyBundleManifest, verifyChannelFile, verifyInstallerManifest } from '@ergosphere-it/protocol'
import { ChannelConflictError, createReleaseStore } from '@ergosphere-it/publish'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { gitRootOf, keygen, parseSigningKey, promote, publishBundle, registerInstaller, setRollout, withdraw, writePrivateKey } from './commands'
import { openStore } from './store'

let root: string
const encode = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
/** Reads a file of the tree that the tests publish to. */
const read = (key: string) => new Uint8Array(readFileSync(join(root, 'storage', ...key.split('/')))) as Uint8Array<ArrayBuffer>

/** Writes the build output of the ergosphere-it plugins with one main file and one page file. */
/** The sha256 of each text that a build wrote. */
const hashes = new Map<string, string>()

async function writeBuild(outDir: string, releaseId: number, page: string, chunks = 0): Promise<void> {
  const chunkFiles = Object.fromEntries(Array.from({ length: chunks }, (_, index) => [`renderer/chunk-${String(index).padStart(2, '0')}.js`, `chunk ${String(index).padStart(2, '0')}`]))
  const files: Record<string, string> = { 'main/index.mjs': 'main', 'renderer/index.html': page, ...chunkFiles }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(outDir, 'bundle', path, '..'), { recursive: true })
    writeFileSync(join(outDir, 'bundle', path), text)
  }
  const entry = async (path: string, text: string) => {
    const sha256 = await contentHash(encode(text))
    hashes.set(text, sha256)
    return { path, sha256, size: encode(text).byteLength }
  }
  const info: BuildInfo = {
    components: [
      { entry: 'main/index.mjs', files: [await entry('main/index.mjs', 'main')], type: 'electron-main' },
      { entry: 'renderer/index.html', files: [await entry('renderer/index.html', page), ...await Promise.all(Object.entries(chunkFiles).map(([path, text]) => entry(path, text)))], type: 'web' },
    ],
    installerReleaseId: releaseId + 1,
    nativeVersion: 2,
    product: 'app',
    releaseId,
    version: `1.0.${releaseId}`,
  }
  writeFileSync(join(outDir, 'bundle.json'), JSON.stringify(info))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ergosphere-cli-'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('ergosphere-it commands', () => {
  it('makes a PEM private key and an OpenSSH public key of one pair', async () => {
    const { privateKey, publicKey } = await keygen()
    const signingKey = await parseSigningKey(privateKey)

    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\w+/=\n]+-----END PRIVATE KEY-----\n$/)
    expect(publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[\w+/]+$/)
    expect((await trustedKeyFromPublicKey(publicKey)).keyId).toBe(signingKey.keyId)
  })

  it('writes the private key to a new file that only its owner reads, and never replaces a file', async () => {
    const { privateKey } = await keygen()
    const path = join(root, 'signing-key.pem')
    writePrivateKey(path, privateKey)

    expect(readFileSync(path, 'utf8')).toBe(privateKey)
    if (platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => writePrivateKey(path, 'another key')).toThrow('exists')
    expect(readFileSync(path, 'utf8')).toBe(privateKey)
  })

  it('finds the git work tree that would commit a private key', () => {
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'repo', 'keys'))

    expect(gitRootOf(join(root, 'repo', 'keys', 'signing-key.pem'))).toBe(join(root, 'repo'))
    expect(gitRootOf(join(root, 'signing-key.pem'))).toBeUndefined()
  })

  it('reads a signing key from a PKCS#8 PEM with real, CRLF, or escaped newlines, or in base64', async () => {
    const { privateKey } = await keygen()
    const expected = await parseSigningKey(privateKey)
    const pem = (newline: string) => privateKey.replaceAll('\n', newline)

    await expect(parseSigningKey(pem('\r\n'))).resolves.toEqual(expected)
    await expect(parseSigningKey(pem('\\n'))).resolves.toEqual(expected)
    // `base64` of GNU coreutils wraps its output at 76 characters.
    await expect(parseSigningKey(encode(privateKey).toBase64().match(/.{1,76}/g)!.join('\n'))).resolves.toEqual(expected)
    // Text that only starts like base64 of a PEM gets the PEM error, not a base64 error.
    await expect(parseSigningKey('LS0tLS1CRUdJTi!')).rejects.toThrow('ERGOSPHERE_IT_SIGNING_KEY is not valid')
    // The base64 DER without the PEM armor was the old form. It is not a PEM.
    await expect(parseSigningKey(privateKey.split('\n').slice(1, -2).join(''))).rejects.toThrow('not an unencrypted PKCS#8 PEM')
    const encrypted = generateKeyPairSync('ed25519', { privateKeyEncoding: { cipher: 'aes-256-cbc', format: 'pem', passphrase: 'secret', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey
    await expect(parseSigningKey(encrypted)).rejects.toThrow('not an unencrypted PKCS#8 PEM')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' })
    await expect(parseSigningKey(rsa)).rejects.toThrow('not an Ed25519 key')
  })

  it('publishes a bundle, skips objects that the store has, and keeps the channel when it moves', async () => {
    const { privateKey, publicKey } = await keygen()
    const signingKey = await parseSigningKey(privateKey)
    const trustedKeys = [await trustedKeyFromPublicKey(publicKey)]
    const store = openStore(join(root, 'storage'))
    const out = join(root, 'out')

    await writeBuild(out, 10, 'page 1')
    expect(await publishBundle({ channel: 'beta', outDir: out, rollout: 20, signingKey, store })).toEqual({ releaseId: 10, uploaded: 2 })
    await writeBuild(out, 11, 'page 2')
    // Only the changed page object is new.
    expect(await publishBundle({ channel: 'beta', minNativeVersion: 1, outDir: out, signingKey, store })).toEqual({ releaseId: 11, uploaded: 1 })

    const manifest = await verifyBundleManifest(read('bundles/11/bundle.json'), decode(read('bundles/11/bundle.json.sig')), trustedKeys)
    expect(manifest.nativeVersion).toEqual({ max: 2, min: 1 })
    const channel = await verifyChannelFile(read('channels/beta.json'), decode(read('channels/beta.json.sig')), trustedKeys, { channel: 'beta', now: new Date(), product: 'app' })
    expect(channel.bundle).toEqual({ releaseId: 11 })
  })

  it('registers the installers of electron-builder and keeps the bundle of the channel', async () => {
    const { privateKey, publicKey } = await keygen()
    const signingKey = await parseSigningKey(privateKey)
    const trustedKeys = [await trustedKeyFromPublicKey(publicKey)]
    const store = openStore(`file://${join(root, 'storage')}`)
    const out = join(root, 'out')
    const dist = join(root, 'dist')
    await writeBuild(out, 10, 'page')
    await publishBundle({ channel: 'stable', outDir: out, signingKey, store })
    mkdirSync(dist)
    writeFileSync(join(dist, 'latest-mac.yml'), stringify({ files: [{ sha512: 'bWFj', size: 1, url: 'App-1.0.10-arm64-mac.zip' }, { sha512: 'ZG1n', size: 2, url: 'App-1.0.10-arm64.dmg' }], version: '1.0.10' }))
    writeFileSync(join(dist, 'latest.yml'), stringify({ files: [{ sha512: 'd2lu', size: 3, url: 'App Setup 1.0.10.exe' }], version: '1.0.10' }))
    writeFileSync(join(dist, 'latest-linux-arm64.yml'), stringify({ files: [{ sha512: 'bGlu', size: 4, url: 'App-1.0.10-arm64.AppImage' }], version: '1.0.10' }))

    const result = await registerInstaller({ channel: 'stable', distDir: dist, filesUrl: 'https://downloads.test/v1.0.10/', outDir: out, signingKey, store })

    expect(result).toEqual({ files: ['linux-arm64 electron-updater (appimage)', 'darwin-arm64 electron-updater', 'win32-x64 electron-updater'], releaseId: 11 })
    const installer = await verifyInstallerManifest(read('installers/11/installer.json'), decode(read('installers/11/installer.json.sig')), trustedKeys)
    expect(installer).toMatchObject({ bundleReleaseId: 10, nativeVersion: 2 })
    expect(installer.artifacts.find(artifact => artifact.platform === 'win32-x64')?.url).toBe('https://downloads.test/v1.0.10/App%20Setup%201.0.10.exe')
    expect(read('installers/11/feeds/win32-x64/latest.yml')).toBeDefined()
    expect(JSON.parse(decode(read('channels/stable.json')))).toMatchObject({ bundle: { releaseId: 10 }, installer: { releaseId: 11 } })
  })

  // AIRI names its feeds with the publish channel `latest-${arch}`, and ships a deb and an rpm for each Linux
  // architecture. Only the first Linux file of a feed named `latest-linux*.yml` counted before.
  it('registers every installer of feeds that a publish channel renames, with one file per Linux package', async () => {
    const { privateKey, publicKey } = await keygen()
    const signingKey = await parseSigningKey(privateKey)
    const trustedKeys = [await trustedKeyFromPublicKey(publicKey)]
    const store = openStore(`file://${join(root, 'storage')}`)
    const out = join(root, 'out')
    const dist = join(root, 'dist')
    await writeBuild(out, 10, 'page')
    mkdirSync(dist)
    const feed = (...urls: string[]) => stringify({ files: urls.map((url, index) => ({ sha512: Buffer.from(url).toString('base64'), size: index + 1, url })), version: '1.0.10' })
    writeFileSync(join(dist, 'latest-arm64-mac.yml'), feed('AIRI-1.0.10-arm64-mac.zip', 'AIRI-1.0.10-darwin-arm64.dmg'))
    writeFileSync(join(dist, 'latest-x64-mac.yml'), feed('AIRI-1.0.10-mac.zip', 'AIRI-1.0.10-darwin-x64.dmg'))
    writeFileSync(join(dist, 'latest-x64.yml'), feed('AIRI-1.0.10-windows-x64-setup.exe'))
    writeFileSync(join(dist, 'latest-x64-linux.yml'), feed('AIRI-1.0.10-linux-amd64.deb', 'AIRI-1.0.10-linux-x86_64.rpm'))
    writeFileSync(join(dist, 'latest-arm64-linux-arm64.yml'), feed('AIRI-1.0.10-linux-arm64.deb', 'AIRI-1.0.10-linux-aarch64.rpm', 'AIRI-1.0.10-linux-arm64.flatpak'))

    await registerInstaller({ channel: 'stable', distDir: dist, filesUrl: 'https://downloads.test/v1.0.10', outDir: out, signingKey, store })

    const installer = await verifyInstallerManifest(read('installers/11/installer.json'), decode(read('installers/11/installer.json.sig')), trustedKeys)
    const files = installer.artifacts.map(artifact => `${artifact.platform} ${artifact.packageType ?? '-'} ${artifact.url.split('/').at(-1)}`).sort()
    expect(files).toEqual([
      'darwin-arm64 - AIRI-1.0.10-arm64-mac.zip',
      'darwin-x64 - AIRI-1.0.10-mac.zip',
      'linux-arm64 deb AIRI-1.0.10-linux-arm64.deb',
      'linux-arm64 rpm AIRI-1.0.10-linux-aarch64.rpm',
      'linux-x64 deb AIRI-1.0.10-linux-amd64.deb',
      'linux-x64 rpm AIRI-1.0.10-linux-x86_64.rpm',
      'win32-x64 - AIRI-1.0.10-windows-x64-setup.exe',
    ])
    // electron-updater reads one feed per platform, and its Linux updaters take the file of their package from it.
    const linuxFeed = parse(decode(read('installers/11/feeds/linux-x64/latest-linux.yml'))) as { files: { url: string }[] }
    expect(linuxFeed.files.map(file => file.url.split('/').at(-1))).toEqual(['AIRI-1.0.10-linux-amd64.deb', 'AIRI-1.0.10-linux-x86_64.rpm'])
    expect(read('installers/11/feeds/linux-arm64/latest-linux-arm64.yml')).toBeDefined()
  })

  it('registers a Sparkle appcast next to the electron-builder installers, and hosts a copy of it in the release', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const store = openStore(join(root, 'storage'))
    const out = join(root, 'out')
    const dist = join(root, 'dist')
    await writeBuild(out, 10, 'page')
    mkdirSync(dist)
    writeFileSync(join(dist, 'latest-mac.yml'), stringify({ files: [{ sha512: 'bWFj', size: 1, url: 'App-1.0.10-arm64-mac.zip' }], version: '1.0.10' }))
    const appcast = '<rss><channel><item><sparkle:shortVersionString>1.0.10</sparkle:shortVersionString><enclosure url="https://downloads.test/App-1.0.10.zip"/></item></channel></rss>'
    writeFileSync(join(dist, 'appcast.xml'), appcast)

    const result = await registerInstaller({
      channel: 'stable',
      distDir: dist,
      downloadPage: 'https://example.test/download',
      feedUrl: 'https://updates.test',
      filesUrl: 'https://downloads.test',
      outDir: out,
      signingKey,
      sparkleAppcasts: { 'darwin-arm64': join(dist, 'appcast.xml') },
      store,
    })

    expect(result.files).toEqual(['darwin-arm64 electron-updater', 'darwin-arm64 sparkle'])
    expect(decode(read('installers/11/sparkle/darwin-arm64/appcast.xml'))).toBe(appcast)
    const manifest = JSON.parse(decode(read('installers/11/installer.json')))
    expect(manifest.downloadPage).toBe('https://example.test/download')
    expect(manifest.artifacts[1]).toMatchObject({ format: 'sparkle', url: 'https://updates.test/installers/11/sparkle/darwin-arm64/appcast.xml' })
  })

  it('refuses an appcast that does not offer the version of the build, or names an archive by a relative URL', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const store = openStore(join(root, 'storage'))
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    const write = (text: string) => {
      writeFileSync(join(root, 'appcast.xml'), text)

      return registerInstaller({ channel: 'stable', distDir: root, feedUrl: 'https://updates.test', outDir: out, signingKey, sparkleAppcasts: { 'darwin-arm64': join(root, 'appcast.xml') }, store })
    }

    await expect(write('<item><sparkle:shortVersionString>1.0.9</sparkle:shortVersionString><enclosure url="https://d.test/a.zip"/></item>')).rejects.toThrow('offers 1.0.9')
    await expect(write('<item><sparkle:shortVersionString>1.0.10</sparkle:shortVersionString><enclosure url="a.zip"/></item>')).rejects.toThrow('relative URL')
    await expect(registerInstaller({ channel: 'stable', distDir: root, outDir: out, signingKey, store })).rejects.toThrow('needs --files-url')
  })

  it('withdraws an installer: the channel stops naming it and lists it as withdrawn', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const store = openStore(join(root, 'storage'))
    const out = join(root, 'out')
    const dist = join(root, 'dist')
    await writeBuild(out, 10, 'page')
    await publishBundle({ channel: 'stable', outDir: out, signingKey, store })
    mkdirSync(dist)
    writeFileSync(join(dist, 'latest.yml'), stringify({ files: [{ sha512: 'd2lu', size: 3, url: 'App Setup.exe' }], version: '1.0.10' }))
    await registerInstaller({ channel: 'stable', distDir: dist, filesUrl: 'https://downloads.test', outDir: out, signingKey, store })

    await withdraw({ signingKey, store }, 11)

    const stable = JSON.parse(decode(read('channels/stable.json')))
    expect(stable).toMatchObject({ bundle: { releaseId: 10 }, withdrawn: [11] })
    expect(stable.installer).toBeUndefined()
  })

  it('promotes a channel, changes a rollout, and withdraws a bundle on every channel', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const store = openStore(join(root, 'storage'))
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    await publishBundle({ channel: 'beta', outDir: out, rollout: 20, signingKey, store })

    expect((await promote({ signingKey, store }, 'beta', 'beta-daily')).bundle).toEqual({ releaseId: 10, rollout: { percentage: 20, salt: '10' } })
    expect((await setRollout({ signingKey, store }, 'beta', 50)).bundle?.rollout).toEqual({ percentage: 50, salt: '10' })
    expect((await withdraw({ signingKey, store }, 10)).sort()).toEqual(['beta', 'beta-daily'])

    const beta = JSON.parse(decode(read('channels/beta.json')))
    expect(beta.bundle).toBeUndefined()
    expect(beta.withdrawn).toEqual([10])
    await expect(promote({ signingKey, store }, 'missing', 'beta')).rejects.toThrow('no channel missing')
  })

  it('withdraws on named channels from a store that cannot list, and asks for --channel otherwise', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const store = { ...openStore(join(root, 'storage')), listChannels: undefined }
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    await publishBundle({ channel: 'beta', outDir: out, signingKey, store })

    await expect(withdraw({ signingKey, store }, 10)).rejects.toThrow('cannot list its channels. Give withdraw a --channel.')
    expect(await withdraw({ signingKey, store }, 10, ['beta'])).toEqual(['beta'])
  })

  it('publishes to a store of callbacks the same documents as to the file tree', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const memory = memoryStore()
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    await publishBundle({ channel: 'beta', outDir: out, signingKey, store: memory.store })

    expect([...memory.objects.keys()]).toHaveLength(2)
    expect(memory.bundles.get(10)?.document.releaseId).toBe(10)
    expect((await verifyBundleManifest(memory.bundles.get(10)!.bytes, memory.bundles.get(10)!.signature, [await trustedKeyFromPublicKey(publicKeyOf(signingKey))])).releaseId).toBe(10)
    expect(memory.channels.get('beta')?.document.bundle).toEqual({ releaseId: 10 })
    // The second publish has the same objects, so it uploads none.
    await writeBuild(out, 11, 'page')
    expect((await publishBundle({ channel: 'beta', outDir: out, signingKey, store: memory.store })).uploaded).toBe(0)
  })

  it('reads the channel again and signs it again when another publish changed it', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const memory = memoryStore()
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    await publishBundle({ channel: 'beta', outDir: out, signingKey, store: memory.store })
    // Another publish changes the rollout after this command read the channel, once.
    let raced = false
    const store = createReleaseStore({
      ...memory.store,
      putChannel: async (next, expected) => {
        if (!raced) {
          raced = true
          await setRollout({ signingKey, store: memory.store }, 'beta', 30)
        }
        await memory.store.putChannel(next, expected)
      },
    })

    const withdrawn = await withdraw({ signingKey, store }, 99, ['beta'])

    expect(withdrawn).toEqual(['beta'])
    expect(memory.channels.get('beta')?.document).toMatchObject({ bundle: { rollout: { percentage: 30 } }, withdrawn: [99] })
  })

  it('checks and uploads at most `concurrency` objects at once, and reports each step in order', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const memory = memoryStore()
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page', 20)
    // The store has the main and the page already, from the bundle before.
    await publishBundle({ channel: 'beta', outDir: out, signingKey, store: memory.store })
    for (const [key] of memory.objects) {
      if (!['main', 'page'].some(text => key === hashes.get(text)))
        memory.objects.delete(key)
    }
    let running = 0
    let peak = 0
    const slow = async (work: () => Promise<void>) => {
      peak = Math.max(peak, ++running)
      await new Promise(resolve => setTimeout(resolve, 5))
      await work()
      running--
    }
    const store = createReleaseStore({
      ...memory.store,
      hasObject: async (sha256) => {
        let has = false
        await slow(async () => {
          has = await memory.store.hasObject!(sha256)
        })
        return has
      },
      putObject: object => slow(() => memory.store.putObject(object)),
    })
    const progress: PublishProgress[] = []

    const result = await publishBundle({ channel: 'beta', concurrency: 3, onProgress: step => progress.push(step), outDir: out, signingKey, store })

    expect(result.uploaded).toBe(20)
    expect(peak).toBe(3)
    expect([...new Set(progress.map(step => step.type))]).toEqual(['release', 'checking', 'checked', 'uploading', 'manifest', 'channel'])
    expect(progress[0]).toMatchObject({ channel: 'beta', objects: 22, releaseId: 10, type: 'release', version: '1.0.10' })
    expect(progress.find(step => step.type === 'checked')).toEqual({ newBytes: 20 * 'chunk 00'.length, newObjects: 20, skipped: 2, type: 'checked' })
    expect(progress.filter(step => step.type === 'uploading').at(-1)).toMatchObject({ uploadedBytes: 20 * 'chunk 00'.length, uploadedObjects: 20 })
    expect(progress.at(-1)).toEqual({ channel: 'beta', releaseId: 10, rollout: 100, type: 'channel' })
  })

  it('stops starting uploads after one fails, and moves no channel', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const memory = memoryStore()
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page', 20)
    let started = 0
    const store = createReleaseStore({
      ...memory.store,
      putObject: async (object) => {
        if (++started === 2)
          throw new Error('The network went away.')
        await memory.store.putObject(object)
      },
    })

    await expect(publishBundle({ channel: 'beta', concurrency: 2, outDir: out, signingKey, store })).rejects.toThrow('The network went away.')
    expect(started).toBeLessThan(5)
    expect(memory.channels.has('beta')).toBe(false)
  })

  it('refuses to change a channel file that no trusted key signed', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const other = await parseSigningKey((await keygen()).privateKey)
    const store = openStore(join(root, 'storage'))
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    await publishBundle({ channel: 'beta', outDir: out, signingKey: other, store })

    await expect(setRollout({ signingKey, store }, 'beta', 50)).rejects.toThrow('does not verify')
    expect((await setRollout({ signingKey, store, trustedKeys: [await trustedKeyFromPublicKey(publicKeyOf(other))] }, 'beta', 50)).bundle?.rollout?.percentage).toBe(50)
  })
})

/**
 * A release store of callbacks that keeps everything in memory, with compare and set on channel files, as the store of
 * a release server can.
 */
function memoryStore() {
  const objects = new Map<string, BundleObject>()
  const bundles = new Map<number, Signed<BundleManifest>>()
  const channels = new Map<string, Signed<ChannelFile>>()
  const store = createReleaseStore({
    getChannel: async channel => channels.get(channel),
    hasObject: async sha256 => objects.has(sha256),
    listChannels: async () => [...channels.keys()],
    name: 'memory',
    putBundle: async (bundle) => {
      bundles.set(bundle.document.releaseId, bundle)
    },
    putChannel: async (next, expected) => {
      if (channels.get(next.document.channel)?.signature !== expected?.signature)
        throw new ChannelConflictError(next.document.channel)
      channels.set(next.document.channel, next)
    },
    putInstaller: async () => {},
    putObject: async (object) => {
      objects.set(object.sha256, object)
    },
  })

  return { bundles, channels, objects, store }
}

/** The public key of a signing key, as `ergo.config.ts` takes it. */
function publicKeyOf(signingKey: SigningKey): string {
  return trustedKeyToOpenSsh({ keyId: signingKey.keyId, publicKey: createPublicKey(createPrivateKey({ format: 'der', key: Buffer.from(signingKey.privateKey, 'base64'), type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).toString('base64') })
}
