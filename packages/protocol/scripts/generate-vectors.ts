// Generates vectors/vectors.json. Run with `pnpm -F @ergosphere-it/protocol vectors`.
// The key pairs in vectors/test-keys.json are test keys. They never sign real releases.

import type { ConformanceVector, ConformanceVectorFile } from '../src/vectors'

import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson, keyIdOf, signBytes } from '../src'
import { base64ToBytes } from '../src/encoding'

interface TestKey { keyId: string, publicKey: string, privateKey: string }

const root = join(import.meta.dirname, '..', 'vectors')
const keysPath = join(root, 'test-keys.json')

async function createKey(): Promise<TestKey> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')

  return { keyId: await keyIdOf(base64ToBytes(spki)!), publicKey: spki, privateKey: pkcs8 }
}

async function loadKeys(): Promise<{ trusted: TestKey, other: TestKey }> {
  if (existsSync(keysPath))
    return JSON.parse(readFileSync(keysPath, 'utf8'))

  const keys = { trusted: await createKey(), other: await createKey() }
  writeFileSync(keysPath, `${JSON.stringify(keys, null, 2)}\n`)

  return keys
}

const { trusted, other } = await loadKeys()
const encode = (text: string) => new TextEncoder().encode(text)

async function signed(document: Record<string, unknown>, key: TestKey = trusted, keyId = key.keyId) {
  const text = canonicalJson({ ...document, signature: { alg: 'ed25519', keyId } })

  return { document: text, signature: await signBytes(encode(text), key.privateKey) }
}

const sha = (char: string) => char.repeat(64)

function core(overrides: Record<string, unknown> = {}) {
  const components = [
    { type: 'electron-main', entry: 'main/index.js', files: [{ path: 'main/index.js', sha256: sha('a'), size: 100 }] },
    { type: 'web', entry: 'renderer/index.html', files: [
      { path: 'renderer/index.html', sha256: sha('b'), size: 20 },
      { path: 'renderer/assets/app.js', sha256: sha('c'), size: 300 },
    ] },
  ]

  return {
    schema: 1,
    kind: 'core',
    product: 'airi',
    seq: 42,
    version: '0.13.0-core.42',
    createdAt: '2026-10-23T00:00:00.000Z',
    host: 'electron',
    platform: 'darwin-arm64',
    hostApi: { min: 3, max: 4 },
    components,
    totalSize: 420,
    ...overrides,
  }
}

const context = { shellHostApi: 3, platform: 'darwin-arm64', builtinSeq: 10 }

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    kind: 'pointer',
    product: 'airi',
    channel: 'canary',
    cadence: 'realtime',
    issuedAt: '2026-10-23T00:00:00.000Z',
    expiresAt: '2026-11-06T00:00:00.000Z',
    core: { seq: 42, rollout: { percentage: 25, salt: '42' }, cohorts: ['alpha', 'beta', 'all'] },
    shell: { seq: 7 },
    revoked: [40, 41],
    ...overrides,
  }
}

const shell = {
  schema: 1,
  kind: 'shell',
  product: 'airi',
  seq: 7,
  version: '0.13.0',
  createdAt: '2026-10-23T00:00:00.000Z',
  host: 'electron',
  hostApi: 3,
  builtinCoreSeq: 10,
  artifacts: [{ platform: 'darwin-arm64', url: 'AIRI-0.13.0-arm64-mac.zip', sha512: 'c2hhNTEy', size: 1024 }],
}

const vectors: ConformanceVector[] = []

const valid = await signed(core())
vectors.push({ name: 'core: valid manifest', kind: 'core-manifest', ...valid, context, expect: { ok: true } })
vectors.push({ name: 'core: valid manifest for any platform', kind: 'core-manifest', ...await signed(core({ platform: 'any' })), context, expect: { ok: true } })
vectors.push({ name: 'core: changed byte after signing', kind: 'core-manifest', document: valid.document.replace('"seq":42', '"seq":43'), signature: valid.signature, context, expect: { ok: false, reason: 'invalid-signature' } })
vectors.push({ name: 'core: signature is not base64', kind: 'core-manifest', document: valid.document, signature: 'not base64!', context, expect: { ok: false, reason: 'invalid-signature' } })
vectors.push({ name: 'core: signed by an untrusted key', kind: 'core-manifest', ...await signed(core(), other), context, expect: { ok: false, reason: 'untrusted-key' } })
vectors.push({ name: 'core: trusted keyId but signed by another key', kind: 'core-manifest', ...await signed(core(), other, trusted.keyId), context, expect: { ok: false, reason: 'invalid-signature' } })
vectors.push({ name: 'core: missing keyId', kind: 'core-manifest', document: canonicalJson(core()), signature: valid.signature, context, expect: { ok: false, reason: 'untrusted-key' } })
vectors.push({ name: 'core: not JSON', kind: 'core-manifest', document: '{"schema":1,', signature: valid.signature, context, expect: { ok: false, reason: 'invalid-json' } })
vectors.push({ name: 'core: seq is zero', kind: 'core-manifest', ...await signed(core({ seq: 0 })), context, expect: { ok: false, reason: 'invalid-schema' } })
vectors.push({ name: 'core: totalSize does not match files', kind: 'core-manifest', ...await signed(core({ totalSize: 1 })), context, expect: { ok: false, reason: 'invalid-schema' } })
vectors.push({ name: 'core: hostApi min above max', kind: 'core-manifest', ...await signed(core({ hostApi: { min: 5, max: 4 } })), context, expect: { ok: false, reason: 'invalid-schema' } })

for (const [label, path] of [['parent segment', '../escape.js'], ['absolute path', '/etc/passwd'], ['drive letter', 'C:/x.js'], ['backslash', 'main\\index.js'], ['dot segment', 'main/./index.js'], ['empty segment', 'main//index.js']]) {
  const manifest = core({ components: [{ type: 'web', files: [{ path, sha256: sha('d'), size: 1 }] }], totalSize: 1 })
  vectors.push({ name: `core: unsafe path, ${label}`, kind: 'core-manifest', ...await signed(manifest), context, expect: { ok: false, reason: 'unsafe-path' } })
}

const duplicate = core({
  components: [
    { type: 'electron-main', files: [{ path: 'shared.js', sha256: sha('a'), size: 1 }] },
    { type: 'web', files: [{ path: 'shared.js', sha256: sha('b'), size: 1 }] },
  ],
  totalSize: 2,
})
vectors.push({ name: 'core: same path in two components', kind: 'core-manifest', ...await signed(duplicate), context, expect: { ok: false, reason: 'duplicate-path' } })

vectors.push({ name: 'core: other platform', kind: 'core-manifest', ...valid, context: { ...context, platform: 'win32-x64' }, expect: { ok: false, reason: 'platform-mismatch' } })
vectors.push({ name: 'core: shell host API below range', kind: 'core-manifest', ...valid, context: { ...context, shellHostApi: 2 }, expect: { ok: false, reason: 'host-api-incompatible' } })
vectors.push({ name: 'core: shell host API above range', kind: 'core-manifest', ...valid, context: { ...context, shellHostApi: 5 }, expect: { ok: false, reason: 'host-api-incompatible' } })
vectors.push({ name: 'core: revoked seq', kind: 'core-manifest', ...valid, context: { ...context, revoked: [42] }, expect: { ok: false, reason: 'revoked' } })
vectors.push({ name: 'core: blocked seq', kind: 'core-manifest', ...valid, context: { ...context, blocked: [42] }, expect: { ok: false, reason: 'blocked' } })
vectors.push({ name: 'core: seq equals builtin', kind: 'core-manifest', ...valid, context: { ...context, builtinSeq: 42 }, expect: { ok: false, reason: 'not-newer' } })
vectors.push({ name: 'core: seq below current', kind: 'core-manifest', ...valid, context: { ...context, currentSeq: 50 }, expect: { ok: false, reason: 'not-newer' } })

const validShell = await signed(shell)
vectors.push({ name: 'shell: valid manifest', kind: 'shell-manifest', ...validShell, expect: { ok: true } })
vectors.push({ name: 'shell: changed byte after signing', kind: 'shell-manifest', document: validShell.document.replace('"hostApi":3', '"hostApi":9'), signature: validShell.signature, expect: { ok: false, reason: 'invalid-signature' } })

const now = '2026-10-24T00:00:00.000Z'
vectors.push({ name: 'pointer: valid canary pointer', kind: 'pointer', ...await signed(pointer()), context: { now }, expect: { ok: true } })
const { core: _core, ...stable } = pointer({ channel: 'stable' })
vectors.push({ name: 'pointer: valid stable pointer without a core', kind: 'pointer', ...await signed(stable), context: { now }, expect: { ok: true } })
vectors.push({ name: 'pointer: expired', kind: 'pointer', ...await signed(pointer()), context: { now: '2026-11-07T00:00:00.000Z' }, expect: { ok: false, reason: 'pointer-expired' } })
vectors.push({ name: 'pointer: older than the last accepted pointer', kind: 'pointer', ...await signed(pointer()), context: { now, lastIssuedAt: '2026-10-23T12:00:00.000Z' }, expect: { ok: false, reason: 'pointer-replayed' } })
vectors.push({ name: 'pointer: same issuedAt as the last accepted pointer', kind: 'pointer', ...await signed(pointer()), context: { now, lastIssuedAt: '2026-10-23T00:00:00.000Z' }, expect: { ok: true } })
vectors.push({ name: 'pointer: expiresAt before issuedAt', kind: 'pointer', ...await signed(pointer({ expiresAt: '2026-10-22T00:00:00.000Z' })), context: { now: '2026-10-21T00:00:00.000Z' }, expect: { ok: false, reason: 'invalid-schema' } })
vectors.push({ name: 'pointer: rollout above 100', kind: 'pointer', ...await signed(pointer({ core: { seq: 42, rollout: { percentage: 101, salt: '42' } } })), context: { now }, expect: { ok: false, reason: 'invalid-schema' } })

for (const [path, expect] of [['main/index.js', true], ['renderer/assets/a b.js', true], ['', false], ['/abs', false], ['../x', false], ['a/../b', false], ['a/./b', false], ['a//b', false], ['a\\b', false], ['C:/x', false], ['c:x', false], ['a\0b', false]] as const)
  vectors.push({ name: `path: ${JSON.stringify(path)}`, kind: 'path', path, expect })

for (const [salt, installId] of [['42', 'install-a'], ['42', 'install-b'], ['43', 'install-a'], ['seq-1', '00000000-0000-4000-8000-000000000000']])
  vectors.push({ name: `rollout: ${salt}:${installId}`, kind: 'rollout', salt, installId, bucket: createHash('sha256').update(`${salt}:${installId}`).digest().readUInt32BE(0) % 100 })

for (const [shellHostApi, min, max, expect] of [[3, 3, 3, true], [3, 1, 5, true], [2, 3, 4, false], [5, 3, 4, false]] as const)
  vectors.push({ name: `host-api: ${shellHostApi} in ${min}..${max}`, kind: 'host-api', shellHostApi, range: { min, max }, expect })

const file: ConformanceVectorFile = {
  trustedKeys: [{ keyId: trusted.keyId, publicKey: trusted.publicKey }],
  vectors,
}

writeFileSync(join(root, 'vectors.json'), `${JSON.stringify(file, null, 2)}\n`)
console.info(`wrote ${vectors.length} vectors`)
