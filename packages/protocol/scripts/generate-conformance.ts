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

function core(overrides: Record<string, unknown> = {}) {
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
    hostApi: { max: 4, min: 3 },
    kind: 'core',
    platform: 'darwin-arm64',
    product: 'airi',
    schema: 1,
    seq: 42,
    totalSize: 420,
    version: '0.13.0-core.42',
    ...overrides,
  }
}

const context = { builtinSeq: 10, host: 'electron', platform: 'darwin-arm64', product: 'airi', shellHostApi: 3 }

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    cadence: 'realtime',
    channel: 'canary',
    core: { cohorts: ['alpha', 'beta', 'all'], rollout: { percentage: 25, salt: '42' }, seq: 42 },
    expiresAt: '2026-11-06T00:00:00.000Z',
    issuedAt: '2026-10-23T00:00:00.000Z',
    kind: 'pointer',
    product: 'airi',
    revoked: [40, 41],
    schema: 1,
    shell: { seq: 7 },
    ...overrides,
  }
}

const shell = {
  artifacts: [{ platform: 'darwin-arm64', sha512: 'c2hhNTEy', size: 1024, url: 'AIRI-0.13.0-arm64-mac.zip' }],
  builtinCoreSeq: 10,
  createdAt: '2026-10-23T00:00:00.000Z',
  host: 'electron',
  hostApi: 3,
  kind: 'shell',
  product: 'airi',
  schema: 1,
  seq: 7,
  version: '0.13.0',
}

const cases: ConformanceCase[] = []

const valid = await signed(core())
cases.push({ kind: 'core-manifest', name: 'core: valid manifest', ...valid, context, expect: { ok: true } })
cases.push({ kind: 'core-manifest', name: 'core: valid manifest for any platform', ...await signed(core({ platform: 'any' })), context, expect: { ok: true } })
cases.push({ context, document: valid.document.replace('"seq":42', '"seq":43'), expect: { code: 'invalid-signature', ok: false }, kind: 'core-manifest', name: 'core: changed byte after signing', signature: valid.signature })
cases.push({ context, document: valid.document, expect: { code: 'invalid-signature', ok: false }, kind: 'core-manifest', name: 'core: signature is not base64', signature: 'not base64!' })
cases.push({ kind: 'core-manifest', name: 'core: signed by an untrusted key', ...await signed(core(), other), context, expect: { code: 'untrusted-key', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: trusted keyId but signed by another key', ...await signed(core(), other, trusted.keyId), context, expect: { code: 'invalid-signature', ok: false } })
cases.push({ context, document: canonicalJson(core()), expect: { code: 'untrusted-key', ok: false }, kind: 'core-manifest', name: 'core: missing keyId', signature: valid.signature })
cases.push({ context, document: '{"schema":1,', expect: { code: 'invalid-json', ok: false }, kind: 'core-manifest', name: 'core: not JSON', signature: valid.signature })
cases.push({ kind: 'core-manifest', name: 'core: seq is zero', ...await signed(core({ seq: 0 })), context, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: totalSize does not match files', ...await signed(core({ totalSize: 1 })), context, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: hostApi min above max', ...await signed(core({ hostApi: { max: 4, min: 5 } })), context, expect: { code: 'invalid-schema', ok: false } })

for (const [label, path] of [['parent segment', '../escape.js'], ['absolute path', '/etc/passwd'], ['drive letter', 'C:/x.js'], ['backslash', 'main\\index.js'], ['dot segment', 'main/./index.js'], ['empty segment', 'main//index.js']]) {
  const manifest = core({ components: [{ files: [{ path, sha256: sha('d'), size: 1 }], type: 'web' }], totalSize: 1 })
  cases.push({ kind: 'core-manifest', name: `core: unsafe path, ${label}`, ...await signed(manifest), context, expect: { code: 'unsafe-path', ok: false } })
}

const duplicate = core({
  components: [
    { files: [{ path: 'shared.js', sha256: sha('a'), size: 1 }], type: 'electron-main' },
    { files: [{ path: 'shared.js', sha256: sha('b'), size: 1 }], type: 'web' },
  ],
  totalSize: 2,
})
cases.push({ kind: 'core-manifest', name: 'core: same path in two components', ...await signed(duplicate), context, expect: { code: 'duplicate-path', ok: false } })

cases.push({ kind: 'core-manifest', name: 'core: another product with the same key', ...await signed(core({ product: 'other' })), context, expect: { code: 'core-mismatch', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: another host', ...await signed(core({ host: 'kirie' })), context, expect: { code: 'core-mismatch', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: other platform', ...valid, context: { ...context, platform: 'win32-x64' }, expect: { code: 'platform-mismatch', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: shell host API below range', ...valid, context: { ...context, shellHostApi: 2 }, expect: { code: 'host-api-incompatible', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: shell host API above range', ...valid, context: { ...context, shellHostApi: 5 }, expect: { code: 'host-api-incompatible', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: revoked seq', ...valid, context: { ...context, revoked: [42] }, expect: { code: 'revoked', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: blocked seq', ...valid, context: { ...context, blocked: [42] }, expect: { code: 'blocked', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: seq equals builtin', ...valid, context: { ...context, builtinSeq: 42 }, expect: { code: 'not-newer', ok: false } })
cases.push({ kind: 'core-manifest', name: 'core: seq below current', ...valid, context: { ...context, currentSeq: 50 }, expect: { code: 'not-newer', ok: false } })

const validShell = await signed(shell)
cases.push({ kind: 'shell-manifest', name: 'shell: valid manifest', ...validShell, expect: { ok: true } })
cases.push({ document: validShell.document.replace('"hostApi":3', '"hostApi":9'), expect: { code: 'invalid-signature', ok: false }, kind: 'shell-manifest', name: 'shell: changed byte after signing', signature: validShell.signature })
const shellContext = { host: 'electron', platform: 'darwin-arm64', product: 'airi', shellSeq: 6 }
cases.push({ kind: 'shell-manifest', name: 'shell: newer shell with an installer for this platform', ...validShell, context: shellContext, expect: { ok: true } })
cases.push({ kind: 'shell-manifest', name: 'shell: another product with the same key', ...await signed({ ...shell, product: 'other' }), context: shellContext, expect: { code: 'shell-mismatch', ok: false } })
cases.push({ kind: 'shell-manifest', name: 'shell: another host', ...await signed({ ...shell, host: 'kirie' }), context: shellContext, expect: { code: 'shell-mismatch', ok: false } })
cases.push({ kind: 'shell-manifest', name: 'shell: no installer for this platform', ...validShell, context: { ...shellContext, platform: 'win32-x64' }, expect: { code: 'platform-mismatch', ok: false } })
cases.push({ kind: 'shell-manifest', name: 'shell: seq equals the installed shell', ...validShell, context: { ...shellContext, shellSeq: 7 }, expect: { code: 'not-newer', ok: false } })

const now = '2026-10-24T00:00:00.000Z'
const target = { cadence: 'realtime', channel: 'canary', product: 'airi' }
cases.push({ kind: 'pointer', name: 'pointer: valid canary pointer', ...await signed(pointer()), context: { ...target, now }, expect: { ok: true } })
const { core: _core, ...stable } = pointer({ channel: 'stable' })
cases.push({ kind: 'pointer', name: 'pointer: valid stable pointer without a core', ...await signed(stable), context: { ...target, channel: 'stable', now }, expect: { ok: true } })
cases.push({ kind: 'pointer', name: 'pointer: another channel at the asked path', ...await signed(stable), context: { ...target, now }, expect: { code: 'pointer-mismatch', ok: false } })
cases.push({ kind: 'pointer', name: 'pointer: another cadence', ...await signed(pointer({ cadence: 'nightly' })), context: { ...target, now }, expect: { code: 'pointer-mismatch', ok: false } })
cases.push({ kind: 'pointer', name: 'pointer: another product with the same key', ...await signed(pointer({ product: 'other' })), context: { ...target, now }, expect: { code: 'pointer-mismatch', ok: false } })
cases.push({ kind: 'pointer', name: 'pointer: expired', ...await signed(pointer()), context: { ...target, now: '2026-11-07T00:00:00.000Z' }, expect: { code: 'pointer-expired', ok: false } })
cases.push({ kind: 'pointer', name: 'pointer: older than the last accepted pointer', ...await signed(pointer()), context: { ...target, lastIssuedAt: '2026-10-23T12:00:00.000Z', now }, expect: { code: 'pointer-replayed', ok: false } })
cases.push({ kind: 'pointer', name: 'pointer: same issuedAt as the last accepted pointer', ...await signed(pointer()), context: { ...target, lastIssuedAt: '2026-10-23T00:00:00.000Z', now }, expect: { ok: true } })
cases.push({ kind: 'pointer', name: 'pointer: expiresAt before issuedAt', ...await signed(pointer({ expiresAt: '2026-10-22T00:00:00.000Z' })), context: { ...target, now: '2026-10-21T00:00:00.000Z' }, expect: { code: 'invalid-schema', ok: false } })
cases.push({ kind: 'pointer', name: 'pointer: rollout above 100', ...await signed(pointer({ core: { rollout: { percentage: 101, salt: '42' }, seq: 42 } })), context: { ...target, now }, expect: { code: 'invalid-schema', ok: false } })

for (const [path, expect] of [['main/index.js', true], ['renderer/assets/a b.js', true], ['', false], ['/abs', false], ['../x', false], ['a/../b', false], ['a/./b', false], ['a//b', false], ['a\\b', false], ['C:/x', false], ['c:x', false], ['a\0b', false]] as const)
  cases.push({ expect, kind: 'path', name: `path: ${JSON.stringify(path)}`, path })

for (const [salt, installId] of [['42', 'install-a'], ['42', 'install-b'], ['43', 'install-a'], ['seq-1', '00000000-0000-4000-8000-000000000000']])
  cases.push({ bucket: createHash('sha256').update(`${salt}:${installId}`).digest().readUInt32BE(0) % 100, installId, kind: 'rollout', name: `rollout: ${salt}:${installId}`, salt })

for (const [shellHostApi, min, max, expect] of [[3, 3, 3, true], [3, 1, 5, true], [2, 3, 4, false], [5, 3, 4, false]] as const)
  cases.push({ expect, kind: 'host-api', name: `host-api: ${shellHostApi} in ${min}..${max}`, range: { max, min }, shellHostApi })

const file: ConformanceSuite = {
  cases,
  trustedKeys: [{ keyId: trusted.keyId, publicKey: trusted.publicKey }],
}

writeFileSync(join(root, 'cases.json'), `${JSON.stringify(file, null, 2)}\n`)
console.info(`wrote ${cases.length} cases`)
