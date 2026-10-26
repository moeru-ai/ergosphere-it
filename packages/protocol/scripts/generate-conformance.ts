// Generates conformance/cases.json. Run with `pnpm -F @ergosphere-it/protocol conformance`.
// The key pairs in conformance/test-keys.json are test keys. They never sign real releases.

import type { ConformanceCase, ConformanceSuite } from '../src/conformance'

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson } from '../src'
import { keyIdOf, signDocument } from '../src/crypto'

interface TestKey { keyId: string, privateKey: string, publicKey: string }

const root = join(import.meta.dirname, '..', 'conformance')
const keysPath = join(root, 'test-keys.json')

async function createKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))

  return { keyId: await keyIdOf(spki), privateKey: pkcs8.toBase64(), publicKey: spki.toBase64() }
}

async function loadKeys(): Promise<{ other: TestKey, trusted: TestKey }> {
  if (existsSync(keysPath))
    return JSON.parse(readFileSync(keysPath, 'utf8'))

  const keys = { other: await createKey(), trusted: await createKey() }
  writeFileSync(keysPath, `${JSON.stringify(keys, null, 2)}\n`)

  return keys
}

const { other, trusted } = await loadKeys()

async function signed(document: Record<string, unknown>, key: TestKey = trusted, keyId = key.keyId) {
  const { bytes, signature } = await signDocument(document, { keyId, privateKey: key.privateKey })

  return { document: new TextDecoder().decode(bytes), signature }
}

const sha = (char: string) => char.repeat(64)

function bundle(overrides: Record<string, unknown> = {}) {
  const components = [
    { entry: 'main/index.js', files: [{ path: 'main/index.js', sha256: sha('a'), size: 100 }], type: 'electron-main' },
    { entry: 'renderer/index.html', files: [
      { path: 'renderer/index.html', sha256: sha('b'), size: 20 },
      { path: 'renderer/assets/app.js', sha256: sha('c'), size: 300 },
    ], type: 'web' },
  ]

  return {
    components,
    createdAt: '2026-10-23T00:00:00.000Z',
    host: 'electron',
    kind: 'bundle',
    nativeVersion: { max: 4, min: 3 },
    platform: 'darwin-arm64',
    product: 'airi',
    releaseId: 42,
    schema: 1,
    totalSize: 420,
    version: '0.13.0-ota.42',
    ...overrides,
  }
}

const context = { host: 'electron', installerBundleReleaseId: 10, nativeVersion: 3, platform: 'darwin-arm64', product: 'airi' }

function channelFile(overrides: Record<string, unknown> = {}) {
  return {
    bundle: { cohorts: ['alpha', 'beta', 'all'], releaseId: 42, rollout: { percentage: 25, salt: '42' } },
    channel: 'canary',
    expiresAt: '2026-11-06T00:00:00.000Z',
    installer: { releaseId: 7 },
    issuedAt: '2026-10-23T00:00:00.000Z',
    kind: 'channel',
    product: 'airi',
    schema: 1,
    withdrawn: [40, 41],
    ...overrides,
  }
}

const installer = {
  artifacts: [
    { format: 'electron-updater', platform: 'darwin-arm64', sha512: 'c2hhNTEy', size: 1024, url: 'https://downloads.example.com/AIRI-0.13.0-arm64-mac.zip' },
    { format: 'sparkle', platform: 'darwin-arm64', sha512: 'YXBwY2FzdA==', size: 2048, url: 'https://updates.example.com/installers/7/sparkle/darwin-arm64/appcast.xml' },
    { format: 'electron-updater', platform: 'win32-x64', sha512: 'c2hhNTEyd2lu', size: 4096, url: 'https://downloads.example.com/AIRI-0.13.0-setup.exe' },
  ],
  bundleReleaseId: 10,
  createdAt: '2026-10-23T00:00:00.000Z',
  host: 'electron',
  kind: 'installer',
  nativeVersion: 3,
  product: 'airi',
  releaseId: 7,
  schema: 1,
  version: '0.13.0',
}

const cases: ConformanceCase[] = []

const valid = await signed(bundle())
cases.push({ kind: 'bundle-manifest', name: 'bundle: valid manifest', ...valid, context, expect: { ok: true } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: valid manifest for any platform', ...await signed(bundle({ platform: 'any' })), context, expect: { ok: true } })
cases.push({ context, document: valid.document.replace('"releaseId":42', '"releaseId":43'), expect: { code: 'invalid-signature', ok: false }, kind: 'bundle-manifest', name: 'bundle: changed byte after signing', signature: valid.signature })
cases.push({ context, document: valid.document, expect: { code: 'invalid-signature', ok: false }, kind: 'bundle-manifest', name: 'bundle: signature is not base64', signature: 'not base64!' })
cases.push({ kind: 'bundle-manifest', name: 'bundle: signed by an untrusted key', ...await signed(bundle(), other), context, expect: { code: 'untrusted-key', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: trusted keyId but signed by another key', ...await signed(bundle(), other, trusted.keyId), context, expect: { code: 'invalid-signature', ok: false } })
cases.push({ context, document: canonicalJson(bundle()), expect: { code: 'untrusted-key', ok: false }, kind: 'bundle-manifest', name: 'bundle: missing keyId', signature: valid.signature })
cases.push({ context, document: '{"schema":1,', expect: { code: 'invalid-json', ok: false }, kind: 'bundle-manifest', name: 'bundle: not JSON', signature: valid.signature })
cases.push({ kind: 'bundle-manifest', name: 'bundle: releaseId is zero', ...await signed(bundle({ releaseId: 0 })), context, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: totalSize does not match files', ...await signed(bundle({ totalSize: 1 })), context, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: nativeVersion min above max', ...await signed(bundle({ nativeVersion: { max: 4, min: 5 } })), context, expect: { code: 'invalid-schema', ok: false } })

for (const [label, path] of [['parent segment', '../escape.js'], ['absolute path', '/etc/passwd'], ['drive letter', 'C:/x.js'], ['backslash', 'main\\index.js'], ['dot segment', 'main/./index.js'], ['empty segment', 'main//index.js']]) {
  const manifest = bundle({ components: [{ files: [{ path, sha256: sha('d'), size: 1 }], type: 'web' }], totalSize: 1 })
  cases.push({ kind: 'bundle-manifest', name: `bundle: unsafe path, ${label}`, ...await signed(manifest), context, expect: { code: 'unsafe-path', ok: false } })
}

const duplicate = bundle({
  components: [
    { files: [{ path: 'shared.js', sha256: sha('a'), size: 1 }], type: 'electron-main' },
    { files: [{ path: 'shared.js', sha256: sha('b'), size: 1 }], type: 'web' },
  ],
  totalSize: 2,
})
cases.push({ kind: 'bundle-manifest', name: 'bundle: same path in two components', ...await signed(duplicate), context, expect: { code: 'duplicate-path', ok: false } })
/** A valid bundle manifest with two extra web files. */
function bundleWith(...paths: string[]) {
  const base = bundle()
  const files = paths.map((path, index) => ({ path, sha256: sha(String.fromCharCode(100 + index)), size: 1 }))
  base.components[1] = { ...base.components[1]!, files: [...base.components[1]!.files, ...files] }

  return { ...base, totalSize: base.totalSize + files.length }
}
for (const [label, paths] of [
  ['paths that differ only in case', ['renderer/App.js', 'renderer/app.js']],
  ['paths that differ only in Unicode normalization', ['renderer/caf\u00E9.js', 'renderer/cafe\u0301.js']],
  ['a file that another path needs as a directory', ['renderer/lib', 'renderer/lib/a.js']],
] as const)
  cases.push({ kind: 'bundle-manifest', name: `bundle: ${label}`, ...await signed(bundleWith(...paths)), context, expect: { code: 'duplicate-path', ok: false } })
for (const [label, path] of [
  ['a Windows device name', 'renderer/aux.js'],
  ['a segment that ends with a dot', 'renderer/app.js.'],
  ['a segment that ends with a space', 'renderer/app.js '],
  ['a colon, as in an NTFS stream', 'renderer/app.js:stream'],
  ['a character that Windows does not allow', 'renderer/a?b.js'],
] as const)
  cases.push({ kind: 'bundle-manifest', name: `bundle: unsafe path with ${label}`, ...await signed(bundleWith(path)), context, expect: { code: 'unsafe-path', ok: false } })

cases.push({ kind: 'bundle-manifest', name: 'bundle: another product with the same key', ...await signed(bundle({ product: 'other' })), context, expect: { code: 'bundle-mismatch', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: another host', ...await signed(bundle({ host: 'kirie' })), context, expect: { code: 'bundle-mismatch', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: other platform', ...valid, context: { ...context, platform: 'win32-x64' }, expect: { code: 'platform-mismatch', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: native version below range', ...valid, context: { ...context, nativeVersion: 2 }, expect: { code: 'native-version-mismatch', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: native version above range', ...valid, context: { ...context, nativeVersion: 5 }, expect: { code: 'native-version-mismatch', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: withdrawn releaseId', ...valid, context: { ...context, withdrawn: [42] }, expect: { code: 'withdrawn', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: blocked releaseId', ...valid, context: { ...context, blocked: [42] }, expect: { code: 'blocked', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: releaseId equals the installer bundle', ...valid, context: { ...context, installerBundleReleaseId: 42 }, expect: { code: 'not-newer', ok: false } })
cases.push({ kind: 'bundle-manifest', name: 'bundle: releaseId below current', ...valid, context: { ...context, currentReleaseId: 50 }, expect: { code: 'not-newer', ok: false } })

const validInstaller = await signed(installer)
cases.push({ kind: 'installer-manifest', name: 'installer: valid manifest', ...validInstaller, expect: { ok: true } })
cases.push({ document: validInstaller.document.replace('"nativeVersion":3', '"nativeVersion":9'), expect: { code: 'invalid-signature', ok: false }, kind: 'installer-manifest', name: 'installer: changed byte after signing', signature: validInstaller.signature })
const installerContext = { formats: ['electron-updater'], host: 'electron', installerReleaseId: 6, platform: 'darwin-arm64', product: 'airi' } as const
cases.push({ kind: 'installer-manifest', name: 'installer: newer installer with a file for this platform', ...validInstaller, context: installerContext, expect: { ok: true } })
cases.push({ kind: 'installer-manifest', name: 'installer: another product with the same key', ...await signed({ ...installer, product: 'other' }), context: installerContext, expect: { code: 'installer-mismatch', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: another host', ...await signed({ ...installer, host: 'kirie' }), context: installerContext, expect: { code: 'installer-mismatch', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: no file for this platform', ...validInstaller, context: { ...installerContext, platform: 'linux-x64' }, expect: { code: 'platform-mismatch', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: releaseId equals the installed app', ...validInstaller, context: { ...installerContext, installerReleaseId: 7 }, expect: { code: 'not-newer', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: a relative installer URL', ...await signed({ ...installer, artifacts: [{ ...installer.artifacts[0]!, url: 'AIRI.zip' }] }), expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: two files of one format for one platform', ...await signed({ ...installer, artifacts: [installer.artifacts[0]!, installer.artifacts[0]!] }), expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: a file of an unknown format', ...await signed({ ...installer, artifacts: [{ ...installer.artifacts[0]!, format: 'squirrel' }] }), expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: a relative download page', ...await signed({ ...installer, downloadPage: 'download' }), expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: an absolute download page', ...await signed({ ...installer, downloadPage: 'https://example.com/download' }), context: installerContext, expect: { ok: true } })
cases.push({ kind: 'installer-manifest', name: 'installer: the install takes sparkle first', ...validInstaller, context: { ...installerContext, formats: ['sparkle', 'electron-updater'] }, expect: { ok: true }, takes: 'sparkle' })
cases.push({ kind: 'installer-manifest', name: 'installer: the install takes electron-updater first', ...validInstaller, context: { ...installerContext, formats: ['electron-updater', 'sparkle'] }, expect: { ok: true }, takes: 'electron-updater' })
cases.push({ kind: 'installer-manifest', name: 'installer: no file in a format that the install takes', ...validInstaller, context: { ...installerContext, formats: ['sparkle'], platform: 'win32-x64' }, expect: { code: 'format-mismatch', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: the install takes no format', ...validInstaller, context: { ...installerContext, formats: [] }, expect: { code: 'format-mismatch', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: withdrawn', ...validInstaller, context: { ...installerContext, withdrawn: [7] }, expect: { code: 'withdrawn', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: withdrawn comes before not newer', ...validInstaller, context: { ...installerContext, installerReleaseId: 7, withdrawn: [7] }, expect: { code: 'withdrawn', ok: false } })

// Linux: electron-updater installs the package that the app came in, so a platform has one file of each package.
const linuxFile = (packageType: string | undefined, extension: string) => ({ format: 'electron-updater', ...(packageType ? { packageType } : {}), platform: 'linux-x64', sha512: 'c2hhNTEybGlu', size: 8192, url: `https://downloads.example.com/AIRI-0.13.0-linux-x64.${extension}` })
const linuxInstaller = await signed({ ...installer, artifacts: [linuxFile('deb', 'deb'), linuxFile('rpm', 'rpm'), linuxFile('appimage', 'AppImage')] })
const linuxContext = { ...installerContext, platform: 'linux-x64' }
cases.push({ kind: 'installer-manifest', name: 'installer: a deb install takes the deb file', ...linuxInstaller, context: { ...linuxContext, packageType: 'deb' }, expect: { ok: true }, takesPackage: 'deb' })
cases.push({ kind: 'installer-manifest', name: 'installer: an rpm install takes the rpm file', ...linuxInstaller, context: { ...linuxContext, packageType: 'rpm' }, expect: { ok: true }, takesPackage: 'rpm' })
cases.push({ kind: 'installer-manifest', name: 'installer: an AppImage install takes the AppImage file', ...linuxInstaller, context: { ...linuxContext, packageType: 'appimage' }, expect: { ok: true }, takesPackage: 'appimage' })
cases.push({ kind: 'installer-manifest', name: 'installer: no file of the package of the install', ...await signed({ ...installer, artifacts: [linuxFile('deb', 'deb'), linuxFile('rpm', 'rpm')] }), context: { ...linuxContext, packageType: 'pacman' }, expect: { code: 'format-mismatch', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: a file without a package serves every package', ...await signed({ ...installer, artifacts: [linuxFile('deb', 'deb'), linuxFile(undefined, 'AppImage')] }), context: { ...linuxContext, packageType: 'rpm' }, expect: { ok: true }, takesPackage: 'none' })
cases.push({ kind: 'installer-manifest', name: 'installer: two files of one package for one platform', ...await signed({ ...installer, artifacts: [linuxFile('deb', 'deb'), linuxFile('deb', 'deb')] }), expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: a package on a file that is not for Linux', ...await signed({ ...installer, artifacts: [{ ...installer.artifacts[0]!, packageType: 'deb' }] }), expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'installer-manifest', name: 'installer: an unknown package', ...await signed({ ...installer, artifacts: [linuxFile('snap', 'snap')] }), expect: { code: 'invalid-schema', ok: false } })

const now = '2026-10-24T00:00:00.000Z'
const target = { channel: 'canary', product: 'airi' }
cases.push({ kind: 'channel', name: 'channel: valid canary channel file', ...await signed(channelFile()), context: { ...target, now }, expect: { ok: true } })
const { bundle: _bundle, ...stable } = channelFile({ channel: 'stable' })
cases.push({ kind: 'channel', name: 'channel: valid stable channel file without a bundle', ...await signed(stable), context: { ...target, channel: 'stable', now }, expect: { ok: true } })
cases.push({ kind: 'channel', name: 'channel: another channel at the asked path', ...await signed(stable), context: { ...target, now }, expect: { code: 'channel-mismatch', ok: false } })
cases.push({ kind: 'channel', name: 'channel: another product with the same key', ...await signed(channelFile({ product: 'other' })), context: { ...target, now }, expect: { code: 'channel-mismatch', ok: false } })
cases.push({ kind: 'channel', name: 'channel: expired', ...await signed(channelFile()), context: { ...target, now: '2026-11-07T00:00:00.000Z' }, expect: { code: 'channel-expired', ok: false } })
cases.push({ kind: 'channel', name: 'channel: older than the last accepted channel file', ...await signed(channelFile()), context: { ...target, lastIssuedAt: '2026-10-23T12:00:00.000Z', now }, expect: { code: 'channel-replayed', ok: false } })
cases.push({ kind: 'channel', name: 'channel: same issuedAt as the last accepted channel file', ...await signed(channelFile()), context: { ...target, lastIssuedAt: '2026-10-23T00:00:00.000Z', now }, expect: { ok: true } })
cases.push({ kind: 'channel', name: 'channel: expiresAt before issuedAt', ...await signed(channelFile({ expiresAt: '2026-10-22T00:00:00.000Z' })), context: { ...target, now: '2026-10-21T00:00:00.000Z' }, expect: { code: 'invalid-schema', ok: false } })
for (const [label, issuedAt] of [['an hour-only offset', '2026-10-23T08:00:00+08'], ['a full offset', '2026-10-23T08:00:00+08:00'], ['a day that does not exist', '2026-02-31T00:00:00.000Z'], ['no time zone', '2026-10-23T00:00:00']])
  cases.push({ kind: 'channel', name: `channel: issuedAt with ${label}`, ...await signed(channelFile({ issuedAt })), context: { ...target, now }, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'channel', name: 'channel: expiresAt with an hour-only offset, which some parsers read as no date', ...await signed(channelFile({ expiresAt: '2026-11-06T00:00:00+08' })), context: { ...target, now: '3000-01-01T00:00:00.000Z' }, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'channel', name: 'channel: releaseId above the largest safe integer', ...await signed(channelFile({ bundle: { releaseId: 2 ** 53 } })), context: { ...target, now }, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'channel', name: 'channel: rollout above 100', ...await signed(channelFile({ bundle: { releaseId: 42, rollout: { percentage: 101, salt: '42' } } })), context: { ...target, now }, expect: { code: 'invalid-schema', ok: false } })

for (const [path, expect] of [['main/index.js', true], ['renderer/assets/a b.js', true], ['', false], ['/abs', false], ['../x', false], ['a/../b', false], ['a/./b', false], ['a//b', false], ['a\\b', false], ['C:/x', false], ['c:x', false], ['a\0b', false]] as const)
  cases.push({ expect, kind: 'path', name: `path: ${JSON.stringify(path)}`, path })

for (const [salt, installId] of [['42', 'install-a'], ['42', 'install-b'], ['43', 'install-a'], ['release-1', '00000000-0000-4000-8000-000000000000']])
  cases.push({ bucket: createHash('sha256').update(`${salt}:${installId}`).digest().readUInt32BE(0) % 100, installId, kind: 'rollout', name: `rollout: ${salt}:${installId}`, salt })

for (const [nativeVersion, min, max, expect] of [[3, 3, 3, true], [3, 1, 5, true], [2, 3, 4, false], [5, 3, 4, false]] as const)
  cases.push({ expect, kind: 'native-version', name: `native-version: ${nativeVersion} in ${min}..${max}`, nativeVersion, range: { max, min } })

const file: ConformanceSuite = {
  cases,
  trustedKeys: [{ keyId: trusted.keyId, publicKey: trusted.publicKey }],
}

writeFileSync(join(root, 'cases.json'), `${JSON.stringify(file, null, 2)}\n`)
console.info(`wrote ${cases.length} cases`)
