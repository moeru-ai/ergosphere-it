import type { BuildInfo } from '../layout'

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { contentHash, verifyBundleManifest, verifyChannelFile, verifyInstallerManifest } from '@ergosphere-it/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { openBucket } from './bucket'
import { keygen, parseSigningKey, promote, publishBundle, registerInstaller, setRollout, withdraw } from './commands'

let root: string
const encode = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

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
  it('makes a key pair whose private key signs and whose public key verifies', async () => {
    const { privateKey, publicKey } = await keygen()

    expect(publicKey).toMatch(/^ed25519:/)
    expect(privateKey).toMatch(/^ed25519:/)
    await expect(parseSigningKey(privateKey.slice('ed25519:'.length))).rejects.toThrow('must start with')
  })

  it('publishes a bundle, skips objects that the bucket has, and keeps the channel when it moves', async () => {
    const { privateKey, publicKey } = await keygen()
    const signingKey = await parseSigningKey(privateKey)
    const trustedKeys = [{ keyId: signingKey.keyId, publicKey: publicKey.slice('ed25519:'.length) }]
    const bucket = openBucket(join(root, 'bucket'))
    const out = join(root, 'out')

    await writeBuild(out, 10, 'page 1')
    expect(await publishBundle({ bucket, channel: 'beta', outDir: out, rollout: 20, signingKey })).toEqual({ releaseId: 10, uploaded: 4 })
    await writeBuild(out, 11, 'page 2')
    // Only the changed page object is new. The manifest and its signature upload too.
    expect(await publishBundle({ bucket, channel: 'beta', minNativeVersion: 1, outDir: out, signingKey })).toEqual({ releaseId: 11, uploaded: 3 })

    const manifest = await verifyBundleManifest((await bucket.get('bundles/11/bundle.json'))!, decode((await bucket.get('bundles/11/bundle.json.sig'))!), trustedKeys)
    expect(manifest.nativeVersion).toEqual({ max: 2, min: 1 })
    const channel = await verifyChannelFile((await bucket.get('channels/beta.json'))!, decode((await bucket.get('channels/beta.json.sig'))!), trustedKeys, { channel: 'beta', now: new Date(), product: 'app' })
    expect(channel.bundle).toEqual({ releaseId: 11 })
  })

  it('registers the installers of electron-builder and keeps the bundle of the channel', async () => {
    const { privateKey, publicKey } = await keygen()
    const signingKey = await parseSigningKey(privateKey)
    const trustedKeys = [{ keyId: signingKey.keyId, publicKey: publicKey.slice('ed25519:'.length) }]
    const bucket = openBucket(`file://${join(root, 'bucket')}`)
    const out = join(root, 'out')
    const dist = join(root, 'dist')
    await writeBuild(out, 10, 'page')
    await publishBundle({ bucket, channel: 'stable', outDir: out, signingKey })
    mkdirSync(dist)
    writeFileSync(join(dist, 'latest-mac.yml'), stringify({ files: [{ sha512: 'bWFj', size: 1, url: 'App-1.0.10-arm64-mac.zip' }, { sha512: 'ZG1n', size: 2, url: 'App-1.0.10-arm64.dmg' }], version: '1.0.10' }))
    writeFileSync(join(dist, 'latest.yml'), stringify({ files: [{ sha512: 'd2lu', size: 3, url: 'App Setup 1.0.10.exe' }], version: '1.0.10' }))
    writeFileSync(join(dist, 'latest-linux-arm64.yml'), stringify({ files: [{ sha512: 'bGlu', size: 4, url: 'App-1.0.10-arm64.AppImage' }], version: '1.0.10' }))

    const result = await registerInstaller({ bucket, channel: 'stable', distDir: dist, filesUrl: 'https://downloads.test/v1.0.10/', outDir: out, signingKey })

    expect(result).toEqual({ files: ['linux-arm64 electron-updater', 'darwin-arm64 electron-updater', 'win32-x64 electron-updater'], releaseId: 11 })
    const installer = await verifyInstallerManifest((await bucket.get('installers/11/installer.json'))!, decode((await bucket.get('installers/11/installer.json.sig'))!), trustedKeys)
    expect(installer).toMatchObject({ bundleReleaseId: 10, nativeVersion: 2 })
    expect(installer.artifacts.find(artifact => artifact.platform === 'win32-x64')?.url).toBe('https://downloads.test/v1.0.10/App%20Setup%201.0.10.exe')
    expect(await bucket.get('installers/11/feeds/win32-x64/latest.yml')).toBeDefined()
    expect(JSON.parse(decode((await bucket.get('channels/stable.json'))!))).toMatchObject({ bundle: { releaseId: 10 }, installer: { releaseId: 11 } })
  })

  it('registers a Sparkle appcast next to the electron-builder installers, and hosts a copy of it in the release', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const bucket = openBucket(join(root, 'bucket'))
    const out = join(root, 'out')
    const dist = join(root, 'dist')
    await writeBuild(out, 10, 'page')
    mkdirSync(dist)
    writeFileSync(join(dist, 'latest-mac.yml'), stringify({ files: [{ sha512: 'bWFj', size: 1, url: 'App-1.0.10-arm64-mac.zip' }], version: '1.0.10' }))
    const appcast = '<rss><channel><item><sparkle:shortVersionString>1.0.10</sparkle:shortVersionString><enclosure url="https://downloads.test/App-1.0.10.zip"/></item></channel></rss>'
    writeFileSync(join(dist, 'appcast.xml'), appcast)

    const result = await registerInstaller({
      bucket,
      channel: 'stable',
      distDir: dist,
      downloadPage: 'https://example.test/download',
      feedUrl: 'https://updates.test',
      filesUrl: 'https://downloads.test',
      outDir: out,
      signingKey,
      sparkleAppcasts: { 'darwin-arm64': join(dist, 'appcast.xml') },
    })

    expect(result.files).toEqual(['darwin-arm64 electron-updater', 'darwin-arm64 sparkle'])
    expect(decode((await bucket.get('installers/11/sparkle/darwin-arm64/appcast.xml'))!)).toBe(appcast)
    const manifest = JSON.parse(decode((await bucket.get('installers/11/installer.json'))!))
    expect(manifest.downloadPage).toBe('https://example.test/download')
    expect(manifest.artifacts[1]).toMatchObject({ format: 'sparkle', url: 'https://updates.test/installers/11/sparkle/darwin-arm64/appcast.xml' })
  })

  it('refuses an appcast that does not offer the version of the build, or names an archive by a relative URL', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const bucket = openBucket(join(root, 'bucket'))
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    const write = (text: string) => {
      writeFileSync(join(root, 'appcast.xml'), text)

      return registerInstaller({ bucket, channel: 'stable', distDir: root, feedUrl: 'https://updates.test', outDir: out, signingKey, sparkleAppcasts: { 'darwin-arm64': join(root, 'appcast.xml') } })
    }

    await expect(write('<item><sparkle:shortVersionString>1.0.9</sparkle:shortVersionString><enclosure url="https://d.test/a.zip"/></item>')).rejects.toThrow('offers 1.0.9')
    await expect(write('<item><sparkle:shortVersionString>1.0.10</sparkle:shortVersionString><enclosure url="a.zip"/></item>')).rejects.toThrow('relative URL')
    await expect(registerInstaller({ bucket, channel: 'stable', distDir: root, outDir: out, signingKey })).rejects.toThrow('needs --files-url')
  })

  it('withdraws an installer: the channel stops naming it and lists it as withdrawn', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const bucket = openBucket(join(root, 'bucket'))
    const out = join(root, 'out')
    const dist = join(root, 'dist')
    await writeBuild(out, 10, 'page')
    await publishBundle({ bucket, channel: 'stable', outDir: out, signingKey })
    mkdirSync(dist)
    writeFileSync(join(dist, 'latest.yml'), stringify({ files: [{ sha512: 'd2lu', size: 3, url: 'App Setup.exe' }], version: '1.0.10' }))
    await registerInstaller({ bucket, channel: 'stable', distDir: dist, filesUrl: 'https://downloads.test', outDir: out, signingKey })

    await withdraw(bucket, 11, signingKey)

    const stable = JSON.parse(decode((await bucket.get('channels/stable.json'))!))
    expect(stable).toMatchObject({ bundle: { releaseId: 10 }, withdrawn: [11] })
    expect(stable.installer).toBeUndefined()
  })

  it('promotes a channel, changes a rollout, and withdraws a bundle on every channel', async () => {
    const signingKey = await parseSigningKey((await keygen()).privateKey)
    const bucket = openBucket(join(root, 'bucket'))
    const out = join(root, 'out')
    await writeBuild(out, 10, 'page')
    await publishBundle({ bucket, channel: 'beta', outDir: out, rollout: 20, signingKey })

    expect((await promote(bucket, 'beta', 'beta-daily', signingKey)).bundle).toEqual({ releaseId: 10, rollout: { percentage: 20, salt: '10' } })
    expect((await setRollout(bucket, 'beta', 50, signingKey)).bundle?.rollout).toEqual({ percentage: 50, salt: '10' })
    expect((await withdraw(bucket, 10, signingKey)).sort()).toEqual(['beta', 'beta-daily'])

    const beta = JSON.parse(decode((await bucket.get('channels/beta.json'))!))
    expect(beta.bundle).toBeUndefined()
    expect(beta.withdrawn).toEqual([10])
    await expect(promote(bucket, 'missing', 'beta', signingKey)).rejects.toThrow('no channel missing')
  })
})
