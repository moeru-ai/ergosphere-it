import type { Cadence, Component, CoreManifest, Distribution, TrustedKey, VerifyReason } from '@ergosphere-it/protocol'

import type { Fetch, UpdateFileSystem } from './io'
import type { ClientState } from './state'

import { evaluateCoreCandidate, isInRollout, sha256Hex, verifyCoreManifest, verifyPointer } from '@ergosphere-it/protocol'

import { loadState, saveState } from './state'
import { ObjectStore } from './store'

/** The core that ships inside the installer. The installer is signed, so the client trusts it without a signature. */
export interface BuiltinCore {
  seq: number
  dir: string
  components: Component[]
}

export interface UpdateClientOptions {
  /** The base URL of the static server, without a trailing slash. */
  baseUrl: string
  channel: string
  cadence: Cadence
  /** The platform of this install, for example `darwin-arm64`. */
  platform: string
  shellHostApi: number
  builtin: BuiltinCore
  /** The directory that the client owns, for example `<userData>/updates`. */
  dataDir: string
  trustedKeys: TrustedKey[]
  distribution: Distribution
  fs: UpdateFileSystem
  fetch?: Fetch
  now?: () => Date
  /** Boots without a healthy report before a core is blocked. */
  maxBootAttempts?: number
  /** Cohort of this install. A pointer with cohorts serves only those cohorts. */
  cohort?: string
}

export type CheckResult
  = | { status: 'disabled', distribution: Distribution }
    | { status: 'no-core' }
    | { status: 'up-to-date', seq: number }
    | { status: 'not-in-rollout', seq: number }
    | { status: 'not-in-cohort', seq: number }
    | { status: 'rejected', reason: VerifyReason, detail?: string }
    | { status: 'available', manifest: CoreManifest, manifestBytes: Uint8Array<ArrayBuffer>, signature: string }

export type StageResult
  = | { status: 'staged', seq: number, downloadedBytes: number, reusedBytes: number }
    | { status: 'failed', path: string, detail: string }

export type BootSelection
  = | { kind: 'external', seq: number, dir: string, components: Component[] }
    | { kind: 'builtin', seq: number, dir: string, components: Component[] }

const CODE_COMPONENTS = new Set<Component['type']>(['electron-main', 'electron-preload'])
const BUILTIN_KEY = 'builtin'

/**
 * The update state machine of one install.
 *
 * It checks a channel pointer, stages a core into its data directory, selects the core to boot, and records health.
 * It never runs code. The host driver loads the selected core.
 */
export class UpdateClient {
  private readonly fs: UpdateFileSystem
  private readonly fetch: Fetch
  private readonly now: () => Date
  private readonly maxBootAttempts: number
  private readonly objects: ObjectStore

  constructor(private readonly options: UpdateClientOptions) {
    this.fs = options.fs
    this.fetch = options.fetch ?? (url => globalThis.fetch(url))
    this.now = options.now ?? (() => new Date())
    this.maxBootAttempts = options.maxBootAttempts ?? 3
    this.objects = new ObjectStore(this.fs, this.path('objects', 'sha256'))
  }

  private path(...parts: string[]): string {
    return this.fs.join(this.options.dataDir, ...parts)
  }

  private get statePath(): string {
    return this.path('state.json')
  }

  coreDir(seq: number): string {
    return this.path('cores', String(seq))
  }

  private manifestPath(seq: number): string {
    return this.path('manifests', `${seq}.json`)
  }

  async state(): Promise<ClientState> {
    return loadState(this.fs, this.statePath)
  }

  private async update(change: (state: ClientState) => void): Promise<ClientState> {
    const state = await this.state()
    change(state)
    await saveState(this.fs, this.statePath, state)

    return state
  }

  private async fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.fetch(url)
    if (!response.ok)
      throw new Error(`GET ${url} returned ${response.status}`)

    return new Uint8Array(await response.arrayBuffer())
  }

  private async fetchText(url: string): Promise<string> {
    return new TextDecoder().decode(await this.fetchBytes(url))
  }

  /** Checks the channel pointer and returns a verified core that this install can take. */
  async check(): Promise<CheckResult> {
    const { distribution, baseUrl, channel, cadence, trustedKeys } = this.options
    if (distribution !== 'direct')
      return { status: 'disabled', distribution }

    const state = await this.state()
    const pointerUrl = `${baseUrl}/pointers/${channel}/${cadence}.json`
    const pointerResult = await verifyPointer(
      await this.fetchBytes(pointerUrl),
      await this.fetchText(`${pointerUrl}.sig`),
      trustedKeys,
      { now: this.now(), lastIssuedAt: state.lastPointerIssuedAt },
    )
    if (!pointerResult.ok)
      return { status: 'rejected', reason: pointerResult.reason, detail: pointerResult.detail }

    const pointer = pointerResult.value
    await this.update((next) => {
      next.lastPointerIssuedAt = pointer.issuedAt
      for (const seq of pointer.revoked ?? []) {
        if (!next.blocked.includes(seq))
          next.blocked.push(seq)
      }
    })

    if (!pointer.core)
      return { status: 'no-core' }

    const target = pointer.core.seq
    const floor = Math.max(this.options.builtin.seq, state.current ?? 0, state.staged ?? 0)
    if (target <= floor)
      return { status: 'up-to-date', seq: Math.max(target, floor) }
    if (pointer.core.cohorts && !pointer.core.cohorts.includes(this.options.cohort ?? 'all'))
      return { status: 'not-in-cohort', seq: target }
    if (!await isInRollout(pointer.core.rollout, state.installId))
      return { status: 'not-in-rollout', seq: target }

    const manifestUrl = `${baseUrl}/cores/${target}/manifest.json`
    const manifestBytes = await this.fetchBytes(manifestUrl)
    const signature = await this.fetchText(`${manifestUrl}.sig`)
    const manifestResult = await verifyCoreManifest(manifestBytes, signature, trustedKeys)
    if (!manifestResult.ok)
      return { status: 'rejected', reason: manifestResult.reason, detail: manifestResult.detail }
    if (manifestResult.value.seq !== target)
      return { status: 'rejected', reason: 'invalid-schema', detail: `manifest seq ${manifestResult.value.seq} is not the pointer seq ${target}` }

    const candidate = evaluateCoreCandidate(manifestResult.value, {
      shellHostApi: this.options.shellHostApi,
      platform: this.options.platform,
      builtinSeq: this.options.builtin.seq,
      currentSeq: Math.max(state.current ?? 0, state.staged ?? 0) || undefined,
      blocked: state.blocked,
      revoked: pointer.revoked,
    })
    if (!candidate.ok)
      return { status: 'rejected', reason: candidate.reason, detail: candidate.detail }

    return { status: 'available', manifest: candidate.value, manifestBytes, signature }
  }

  /** Paths of files on disk that can give an object without a download: the running core and the builtin core. */
  private async localSources(): Promise<Map<string, string>> {
    const sources = new Map<string, string>()
    const add = (dir: string, components: readonly Component[]) => {
      for (const component of components) {
        for (const file of component.files) {
          if (!sources.has(file.sha256))
            sources.set(file.sha256, this.fs.join(dir, ...file.path.split('/')))
        }
      }
    }

    const state = await this.state()
    for (const seq of [state.current, state.previous]) {
      if (seq === undefined)
        continue

      const manifest = await this.readStoredManifest(seq)
      if (manifest)
        add(this.coreDir(seq), manifest.components)
    }
    add(this.options.builtin.dir, this.options.builtin.components)

    return sources
  }

  /** Downloads the missing objects of a checked core, builds its directory, and marks it as staged. */
  async stage(available: Extract<CheckResult, { status: 'available' }>): Promise<StageResult> {
    const { manifest, manifestBytes, signature } = available
    const sources = await this.localSources()
    let downloadedBytes = 0
    let reusedBytes = 0

    for (const component of manifest.components) {
      for (const file of component.files) {
        if (await this.objects.hasValid(file.sha256, file.size)) {
          reusedBytes += file.size
          continue
        }

        const local = sources.get(file.sha256)
        if (local) {
          const bytes = await this.fs.readFile(local)
          if (bytes && await this.objects.put(file.sha256, file.size, bytes)) {
            reusedBytes += file.size
            continue
          }
        }

        const url = `${this.options.baseUrl}/objects/sha256/${file.sha256.slice(0, 2)}/${file.sha256}`
        let bytes: Uint8Array<ArrayBuffer>
        try {
          bytes = await this.fetchBytes(url)
        }
        catch (error) {
          return { status: 'failed', path: file.path, detail: error instanceof Error ? error.message : String(error) }
        }
        if (!await this.objects.put(file.sha256, file.size, bytes))
          return { status: 'failed', path: file.path, detail: `downloaded bytes do not match sha256 ${file.sha256}` }

        downloadedBytes += file.size
      }
    }

    const target = this.coreDir(manifest.seq)
    const building = this.path('cores', `.building-${manifest.seq}`)
    await this.fs.remove(building)
    for (const component of manifest.components) {
      for (const file of component.files)
        await this.fs.copyFile(this.objects.pathOf(file.sha256), this.fs.join(building, ...file.path.split('/')))
    }
    await this.fs.remove(target)
    await this.fs.rename(building, target)
    await this.fs.writeFileAtomic(this.manifestPath(manifest.seq), manifestBytes)
    await this.fs.writeFileAtomic(`${this.manifestPath(manifest.seq)}.sig`, new TextEncoder().encode(signature))

    await this.update((next) => {
      next.staged = manifest.seq
      if (next.deferred === manifest.seq)
        next.deferred = undefined
    })
    await this.collectGarbage()

    return { status: 'staged', seq: manifest.seq, downloadedBytes, reusedBytes }
  }

  private async readStoredManifest(seq: number): Promise<CoreManifest | undefined> {
    const bytes = await this.fs.readFile(this.manifestPath(seq))
    const signature = await this.fs.readFile(`${this.manifestPath(seq)}.sig`)
    if (!bytes || !signature)
      return undefined

    const result = await verifyCoreManifest(bytes, new TextDecoder().decode(signature), this.options.trustedKeys)

    return result.ok ? result.value : undefined
  }

  /** Checks one stored core before boot. Returns the reason it cannot boot, or `undefined`. */
  private async inspect(seq: number, state: ClientState): Promise<{ manifest?: CoreManifest, problem?: string, permanent?: boolean }> {
    const manifest = await this.readStoredManifest(seq)
    if (!manifest)
      return { problem: 'manifest is missing or does not verify', permanent: true }

    const candidate = evaluateCoreCandidate(manifest, {
      shellHostApi: this.options.shellHostApi,
      platform: this.options.platform,
      builtinSeq: this.options.builtin.seq,
      blocked: state.blocked,
    })
    if (!candidate.ok)
      return { manifest, problem: candidate.reason, permanent: candidate.reason !== 'host-api-incompatible' }

    const dir = this.coreDir(seq)
    for (const component of manifest.components) {
      for (const file of component.files) {
        const path = this.fs.join(dir, ...file.path.split('/'))
        if (await this.fs.fileSize(path) !== file.size)
          return { manifest, problem: `file ${file.path} is missing or has the wrong size`, permanent: true }

        // NOTICE:
        // Code files are hashed on every boot. Large web assets are checked by size only.
        // Hashing every file adds about 600 ms to a cold start (measured by LobeHub Desktop).
        // The client hashed every object when it stored it, and nothing else writes to the core directory.
        // Remove this split when hashing all files at boot costs less than 100 ms.
        if (CODE_COMPONENTS.has(component.type)) {
          const bytes = await this.fs.readFile(path)
          if (!bytes || await sha256Hex(bytes) !== file.sha256)
            return { manifest, problem: `file ${file.path} does not match its hash`, permanent: true }
        }
      }
    }

    if ((state.bootAttempts[String(seq)] ?? 0) >= this.maxBootAttempts)
      return { manifest, problem: `boot attempts reached ${this.maxBootAttempts} without a healthy report`, permanent: true }

    return { manifest }
  }

  /**
   * Selects the core to boot: staged, then current, then previous, then builtin.
   *
   * It counts the boot attempt of the selected core. The host must call `markHealthy` when the app works.
   */
  async selectBoot(): Promise<BootSelection & { rejected: { seq: number, problem: string }[] }> {
    const state = await this.state()
    const rejected: { seq: number, problem: string }[] = []
    const accepted: { seq: number, manifest: CoreManifest }[] = []
    const seen = new Set<number>()

    for (const seq of [state.staged, state.current, state.previous]) {
      if (seq === undefined || seen.has(seq))
        continue

      seen.add(seq)
      const result = await this.inspect(seq, state)
      if (result.problem === undefined && result.manifest) {
        accepted.push({ seq, manifest: result.manifest })
        continue
      }

      rejected.push({ seq, problem: result.problem ?? 'unknown' })
      if (result.permanent && !state.blocked.includes(seq))
        state.blocked.push(seq)
      if (!result.permanent && seq === state.staged)
        state.deferred = seq
    }

    const chosen = accepted[0]
    state.staged = undefined
    state.current = chosen?.seq
    state.previous = accepted[1]?.seq
    const key = chosen ? String(chosen.seq) : BUILTIN_KEY
    state.bootAttempts[key] = (state.bootAttempts[key] ?? 0) + 1
    await saveState(this.fs, this.statePath, state)

    if (chosen)
      return { kind: 'external', seq: chosen.seq, dir: this.coreDir(chosen.seq), components: chosen.manifest.components, rejected }

    const { builtin } = this.options

    return { kind: 'builtin', seq: builtin.seq, dir: builtin.dir, components: builtin.components, rejected }
  }

  /** Records that the core works. It clears the boot attempts of that core. */
  async markHealthy(selection: BootSelection): Promise<void> {
    await this.update((state) => {
      state.bootAttempts[selection.kind === 'builtin' ? BUILTIN_KEY : String(selection.seq)] = 0
    })
  }

  /**
   * Blocks a core that failed its health check and points the install back to the previous core.
   *
   * Returns the seq to run next, or `undefined` for the builtin core.
   */
  async rollback(seq: number): Promise<number | undefined> {
    const state = await this.update((next) => {
      if (!next.blocked.includes(seq))
        next.blocked.push(seq)
      if (next.staged === seq)
        next.staged = undefined
      if (next.current === seq) {
        next.current = next.previous
        next.previous = undefined
      }
    })

    return state.current
  }

  /** Removes cores and objects that no kept core uses. */
  async collectGarbage(): Promise<void> {
    const state = await this.state()
    const keep = new Set([state.staged, state.current, state.previous, state.deferred].filter((seq): seq is number => seq !== undefined))
    const used = new Set<string>()

    for (const name of await this.fs.list(this.path('cores'))) {
      const seq = Number(name)
      if (!keep.has(seq))
        await this.fs.remove(this.path('cores', name))
    }
    for (const name of await this.fs.list(this.path('manifests'))) {
      const seq = Number(name.split('.')[0])
      if (!keep.has(seq))
        await this.fs.remove(this.path('manifests', name))
    }
    for (const seq of keep) {
      const manifest = await this.readStoredManifest(seq)
      for (const component of manifest?.components ?? []) {
        for (const file of component.files)
          used.add(file.sha256)
      }
    }
    for (const hash of await this.objects.list()) {
      if (!used.has(hash))
        await this.objects.remove(hash)
    }
  }
}
