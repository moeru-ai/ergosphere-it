import type { BundleManifest, ChannelFile, SigningKey } from '@ergosphere-it/protocol'
import type { BundleObject, Signed } from '@ergosphere-it/publish'

import type { BuildInfo } from '../layout'

import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

import { contentHash, trustedKeyFromPublicKey, trustedKeyToOpenSsh, verifyBundleManifest, verifyChannelFile, verifyInstallerManifest } from '@ergosphere-it/protocol'
import { ChannelConflictError, createReleaseStore } from '@ergosphere-it/publish'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { gitRootOf, keygen, parseSigningKey, promote, publishBundle, registerInstaller, setRollout, withdraw, writePrivateKey } from './commands'
import { openStore } from './store'

let root: string
const encode = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
/** Reads a file of the tree that the tests publish to. */
const read = (key: string) => new Uint8Array(readFileSync(join(root, 'storage', ...key.split('/')))) as Uint8Array<ArrayBuffer>

/** Writes the build output of the ergosphere-it plugins with one main file and one page file. */
async function writeBuild(outDir: string, releaseId: number, page: string): Promise<void> {
  const files = { 'main/index.mjs': 'main', 'renderer/index.html': page }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(outDir, 'bundle', path, '..'), { recursive: true })
    writeFileSync(join(outDir, 'bundle', path), text)
  }
  const entry = async (path: string, text: string) => ({ path, sha256: await contentHash(encode(text)), size: encode(text).byteLength })
  const info: BuildInfo = {
    components: [
      { entry: 'main/index.mjs', files: [await entry('main/index.mjs', 'main')], type: 'electron-main' },
      { entry: 'renderer/index.html', files: [await entry('renderer/index.html', page)], type: 'web' },
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

    expect(result).toEqual({ files: ['linux-arm64 electron-updater', 'darwin-arm64 electron-updater', 'win32-x64 electron-updater'], releaseId: 11 })
    const installer = await verifyInstallerManifest(read('installers/11/installer.json'), decode(read('installers/11/installer.json.sig')), trustedKeys)
    expect(installer).toMatchObject({ bundleReleaseId: 10, nativeVersion: 2 })
    expect(installer.artifacts.find(artifact => artifact.platform === 'win32-x64')?.url).toBe('https://downloads.test/v1.0.10/App%20Setup%201.0.10.exe')
    expect(read('installers/11/feeds/win32-x64/latest.yml')).toBeDefined()
    expect(JSON.parse(decode(read('channels/stable.json')))).toMatchObject({ bundle: { releaseId: 10 }, installer: { releaseId: 11 } })
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
