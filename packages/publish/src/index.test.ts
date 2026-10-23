import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { keygen, loadSigningKey, nextSeq, reissuePointers, writePointer } from './index'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ergosphere-publish-'))
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

async function addCore(seq: number): Promise<void> {
  await mkdir(join(root, 'tree', 'cores', String(seq)), { recursive: true })
  await writeFile(join(root, 'tree', 'cores', String(seq), 'manifest.json'), JSON.stringify({ components: [], seq, version: String(seq) }))
}

describe('nextSeq', () => {
  it('uses the current time, so a tree that lost releases still gives a seq above every earlier one', async () => {
    expect(await nextSeq(join(root, 'tree'), 1_000_000)).toBe(1_000_000)

    await addCore(5)
    expect(await nextSeq(join(root, 'tree'), 1_000_000)).toBe(1_000_000)
  })

  it('goes above the largest seq in the tree when the clock is behind it', async () => {
    await addCore(2_000_000)

    expect(await nextSeq(join(root, 'tree'), 1_000_000)).toBe(2_000_001)
  })
})

describe('reissuePointers', () => {
  it('signs every pointer again with a later issue time and the same content', async () => {
    await keygen(join(root, 'keys'))
    const key = await loadSigningKey(join(root, 'keys', 'signing-key.json'))
    const tree = join(root, 'tree')
    await writePointer({ cadence: 'realtime', channel: 'canary', coreSeq: 7, issuedAt: '2026-01-01T00:00:00.000Z', key, product: 'test', revoked: [5], tree })

    const [pointer] = await reissuePointers({ key, product: 'test', tree })
    const stored = JSON.parse(await readFile(join(tree, 'pointers', 'canary', 'realtime.json'), 'utf8'))

    expect(Date.parse(pointer!.issuedAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(stored).toMatchObject({ core: { seq: 7 }, revoked: [5] })
  })
})
