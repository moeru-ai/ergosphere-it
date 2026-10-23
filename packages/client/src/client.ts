import type { Cadence, Component, CoreManifest, Distribution, TrustedKey } from '@ergosphere-it/protocol'

import type { Fetch, UpdateFileSystem } from './io'
import type { ClientState } from './state'

import { CandidateError, checkCoreCandidate, contentHash, DocumentError, ErgosphereError, isInRollout, verifyCoreManifest, verifyPointer } from '@ergosphere-it/protocol'
import { errorMessageFrom } from '@moeru/std/error'
import { sumBy } from 'es-toolkit'

import { loadState, saveState } from './state'
import { ObjectStore } from './store'

export type BootSelection
  = | { components: Component[], dir: string, kind: 'builtin' | 'external', seq: number, version: string }

/** The core that ships inside the installer. The installer is signed, so the client trusts it without a signature. */
export interface BuiltinCore {
  components: Component[]
  dir: string
  seq: number
  version: string
}

/**
 * The result of an update check.
 *
 * `server-behind` means the channel serves an older core than this install runs, for example after the server went
 * back to a backup. `rejected` means the protocol rejected the pointer or the core, and `error.code` comes from the
 * specification.
 */
export type CheckResult
  = | { current: number, seq: number, status: 'server-behind' }
    | { distribution: Distribution, status: 'disabled' }
    | { error: ErgosphereError, status: 'rejected' }
    | { manifest: CoreManifest, manifestBytes: Uint8Array<ArrayBuffer>, signature: string, status: 'available' }
    | { seq: number, status: 'not-in-cohort' }
    | { seq: number, status: 'not-in-rollout' }
    | { seq: number, status: 'up-to-date' }
    | { status: 'no-core' }

export interface StageOptions {
  onProgress?: (progress: StageProgress) => void
}

export interface StageProgress {
  /** Bytes downloaded so far. Objects taken from disk do not count. */
  downloadedBytes: number
  /** Bytes of all objects that need a download. */
  totalBytes: number
}

export type StageResult
  = | { detail: string, path: string, status: 'failed' }
    | { downloadedBytes: number, reusedBytes: number, seq: number, status: 'staged' }

export interface UpdateClientOptions {
  /** The base URL of the static server, without a trailing slash. */
  baseUrl: string
  builtin: BuiltinCore
  cadence: Cadence
  channel: string
  /** Cohort of this install. A pointer with cohorts serves only those cohorts. */
  cohort?: string
  /** The directory that the client owns, for example `<userData>/updates`. */
  dataDir: string
  distribution: Distribution
  fetch?: Fetch
  fs: UpdateFileSystem
  /** The host that runs cores, for example `electron`. A core for another host is rejected. */
  host: string
  /** Boots without a healthy report before a core is blocked. */
  maxBootAttempts?: number
  now?: () => Date
  /** The platform of this install, for example `darwin-arm64`. */
  platform: string
  /** The product of this install. Pointers and cores of another product are rejected, even with a valid signature. */
  product: string
  shellHostApi: number
  trustedKeys: TrustedKey[]
}

const CODE_COMPONENTS = new Set<Component['type']>(['electron-main', 'electron-preload'])
const BUILTIN_KEY = 'builtin'

/**
 * The update state machine of one install.
 *
 * It checks a channel pointer, stages a core into its data directory, selects the core to boot, and records health.
 * It never runs code. The host driver loads the selected core.
 */
export class UpdateClient {
  private readonly fetch: Fetch
  private readonly fs: UpdateFileSystem
  private readonly maxBootAttempts: number
  private readonly now: () => Date
  private readonly objects: ObjectStore

  private get statePath(): string {
    return this.path('state.json')
  }

  constructor(private readonly options: UpdateClientOptions) {
    this.fs = options.fs
    this.fetch = options.fetch ?? (url => globalThis.fetch(url))
    this.now = options.now ?? (() => new Date())
    this.maxBootAttempts = options.maxBootAttempts ?? 3
    this.objects = new ObjectStore(this.fs, this.path('objects', 'sha256'))
  }

  /**
   * Makes the staged core current without a restart, for a change that only reloads pages.
   *
   * The core that ran before becomes `previous`, so `rollback` can return to it.
   */
  async activateInPlace(seq: number): Promise<void> {
    await this.update((state) => {
      if (state.staged !== seq)
        throw new Error(`activateInPlace: core ${seq} is not staged`)

      state.previous = state.current
      state.current = seq
      state.staged = undefined
    })
  }

  /**
   * Selects the core to boot: staged, then current, then previous, then builtin.
   *
   * It counts the boot attempt of the selected core. The host must call `markHealthy` when the app works.
   */
  async boot(): Promise<BootSelection & { rejected: { problem: string, seq: number }[] }> {
    const state = await this.state()
    const rejected: { problem: string, seq: number }[] = []
    const accepted: { manifest: CoreManifest, seq: number }[] = []
    const seen = new Set<number>()

    for (const seq of [state.staged, state.current, state.previous]) {
      if (seq === undefined || seen.has(seq))
        continue

      seen.add(seq)
      const result = await this.inspect(seq, state)
      if (result.problem === undefined && result.manifest) {
        accepted.push({ manifest: result.manifest, seq })
        continue
      }

      rejected.push({ problem: result.problem ?? 'unknown', seq })
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
      return { components: chosen.manifest.components, dir: this.coreDir(chosen.seq), kind: 'external', rejected, seq: chosen.seq, version: chosen.manifest.version }

    const { builtin } = this.options

    return { components: builtin.components, dir: builtin.dir, kind: 'builtin', rejected, seq: builtin.seq, version: builtin.version }
  }

  /**
   * Checks the channel pointer and returns a verified core that this install can take.
   *
   * A rejection by the protocol is a result, not an error. Network and file system errors throw.
   */
  async check(): Promise<CheckResult> {
    try {
      return await this.checkPointer()
    }
    catch (error) {
      if (error instanceof ErgosphereError)
        return { error, status: 'rejected' }

      throw error
    }
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

  coreDir(seq: number): string {
    return this.path('cores', String(seq))
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

  /** Downloads the missing objects of a checked core, builds its directory, and marks it as staged. */
  async stage(available: Extract<CheckResult, { status: 'available' }>, options: StageOptions = {}): Promise<StageResult> {
    const { manifest, manifestBytes, signature } = available
    const sources = await this.localSources()
    const missing = new Map<string, { path: string, size: number }>()
    let reusedBytes = 0

    // Phase 1: take every object that is already on disk, and list the objects to download.
    for (const component of manifest.components) {
      for (const file of component.files) {
        if (missing.has(file.sha256) || await this.objects.hasValid(file.sha256, file.size)) {
          if (!missing.has(file.sha256))
            reusedBytes += file.size
          continue
        }

        const local = sources.get(file.sha256)
        const bytes = local ? await this.fs.readFile(local) : undefined
        if (bytes && await this.objects.put(file.sha256, file.size, bytes)) {
          reusedBytes += file.size
          continue
        }

        missing.set(file.sha256, { path: file.path, size: file.size })
      }
    }

    // Phase 2: download the missing objects and report progress against their total size.
    const totalBytes = sumBy([...missing.values()], object => object.size)
    let downloadedBytes = 0
    options.onProgress?.({ downloadedBytes, totalBytes })

    for (const [hash, object] of missing) {
      const url = `${this.options.baseUrl}/objects/sha256/${hash.slice(0, 2)}/${hash}`
      const before = downloadedBytes
      let bytes: Uint8Array<ArrayBuffer>
      try {
        bytes = await this.fetchBytes(url, (received) => {
          downloadedBytes = before + Math.min(received, object.size)
          options.onProgress?.({ downloadedBytes, totalBytes })
        })
      }
      catch (error) {
        return { detail: errorMessageFrom(error) ?? 'download failed', path: object.path, status: 'failed' }
      }
      if (!await this.objects.put(hash, object.size, bytes))
        return { detail: `downloaded bytes do not match sha256 ${hash}`, path: object.path, status: 'failed' }

      downloadedBytes = before + object.size
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

    return { downloadedBytes, reusedBytes, seq: manifest.seq, status: 'staged' }
  }

  async state(): Promise<ClientState> {
    return loadState(this.fs, this.statePath)
  }

  /** Returns a stored core after it verifies its manifest, without a boot attempt. */
  async storedCore(seq: number): Promise<BootSelection | undefined> {
    const manifest = await this.readStoredManifest(seq)

    return manifest ? { components: manifest.components, dir: this.coreDir(seq), kind: 'external', seq, version: manifest.version } : undefined
  }

  private async checkPointer(): Promise<CheckResult> {
    const { baseUrl, cadence, channel, distribution, trustedKeys } = this.options
    if (distribution !== 'direct')
      return { distribution, status: 'disabled' }

    const state = await this.state()
    const pointerUrl = `${baseUrl}/pointers/${channel}/${cadence}.json`
    const pointer = await verifyPointer(
      await this.fetchBytes(pointerUrl),
      await this.fetchText(`${pointerUrl}.sig`),
      trustedKeys,
      { cadence, channel, lastIssuedAt: state.lastPointerIssuedAt, now: this.now(), product: this.options.product },
    )
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
    // A client never moves back. When the channel serves less than this install has, it reports that and waits for a
    // newer release.
    const ahead = Math.max(state.current ?? 0, state.staged ?? 0)
    if (target < ahead)
      return { current: ahead, seq: target, status: 'server-behind' }

    const floor = Math.max(this.options.builtin.seq, ahead)
    if (target <= floor)
      return { seq: Math.max(target, floor), status: 'up-to-date' }
    if (pointer.core.cohorts && !pointer.core.cohorts.includes(this.options.cohort ?? 'all'))
      return { seq: target, status: 'not-in-cohort' }
    if (!await isInRollout(pointer.core.rollout, state.installId))
      return { seq: target, status: 'not-in-rollout' }
    // A blocked core stays blocked, so skip its manifest. Otherwise every check downloads it again to reject it.
    if (pointer.revoked?.includes(target))
      throw new CandidateError('revoked', `Core ${target} is revoked.`, target)
    if (state.blocked.includes(target))
      throw new CandidateError('blocked', `Core ${target} is blocked on this install.`, target)

    const manifestUrl = `${baseUrl}/cores/${target}/manifest.json`
    const manifestBytes = await this.fetchBytes(manifestUrl)
    const signature = await this.fetchText(`${manifestUrl}.sig`)
    const manifest = await verifyCoreManifest(manifestBytes, signature, trustedKeys)
    if (manifest.seq !== target)
      throw new DocumentError('invalid-schema', `The manifest seq ${manifest.seq} is not the pointer seq ${target}.`)

    checkCoreCandidate(manifest, {
      blocked: state.blocked,
      builtinSeq: this.options.builtin.seq,
      currentSeq: Math.max(state.current ?? 0, state.staged ?? 0) || undefined,
      host: this.options.host,
      platform: this.options.platform,
      product: this.options.product,
      revoked: pointer.revoked,
      shellHostApi: this.options.shellHostApi,
    })

    return { manifest, manifestBytes, signature, status: 'available' }
  }

  private async fetchBytes(url: string, onBytes?: (received: number) => void): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.fetch(url)
    if (!response.ok)
      throw new Error(`GET ${url} returned ${response.status}`)
    if (!onBytes || !response.body)
      return new Uint8Array(await response.arrayBuffer())

    const chunks: Uint8Array[] = []
    let received = 0
    const reader = response.body.getReader()
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      chunks.push(chunk.value)
      received += chunk.value.byteLength
      onBytes(received)
    }

    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return bytes
  }

  private async fetchText(url: string): Promise<string> {
    return new TextDecoder().decode(await this.fetchBytes(url))
  }

  /** Checks one stored core before boot. Returns the reason it cannot boot, or `undefined`. */
  private async inspect(seq: number, state: ClientState): Promise<{ manifest?: CoreManifest, permanent?: boolean, problem?: string }> {
    const manifest = await this.readStoredManifest(seq)
    if (!manifest)
      return { permanent: true, problem: 'manifest is missing or does not verify' }

    try {
      checkCoreCandidate(manifest, {
        blocked: state.blocked,
        builtinSeq: this.options.builtin.seq,
        host: this.options.host,
        platform: this.options.platform,
        product: this.options.product,
        shellHostApi: this.options.shellHostApi,
      })
    }
    catch (error) {
      if (!(error instanceof CandidateError))
        throw error

      return { manifest, permanent: error.code !== 'host-api-incompatible', problem: error.code }
    }

    const dir = this.coreDir(seq)
    for (const component of manifest.components) {
      for (const file of component.files) {
        const path = this.fs.join(dir, ...file.path.split('/'))
        if (await this.fs.fileSize(path) !== file.size)
          return { manifest, permanent: true, problem: `file ${file.path} is missing or has the wrong size` }

        // NOTICE:
        // Code files are hashed on every boot. Large web assets are checked by size only.
        // Hashing every file adds about 600 ms to a cold start (measured by LobeHub Desktop).
        // The client hashed every object when it stored it, and nothing else writes to the core directory.
        // Remove this split when hashing all files at boot costs less than 100 ms.
        if (CODE_COMPONENTS.has(component.type)) {
          const bytes = await this.fs.readFile(path)
          if (!bytes || await contentHash(bytes) !== file.sha256)
            return { manifest, permanent: true, problem: `file ${file.path} does not match its hash` }
        }
      }
    }

    if ((state.bootAttempts[String(seq)] ?? 0) >= this.maxBootAttempts)
      return { manifest, permanent: true, problem: `boot attempts reached ${this.maxBootAttempts} without a healthy report` }

    return { manifest }
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

  private manifestPath(seq: number): string {
    return this.path('manifests', `${seq}.json`)
  }

  private path(...parts: string[]): string {
    return this.fs.join(this.options.dataDir, ...parts)
  }

  private async readStoredManifest(seq: number): Promise<CoreManifest | undefined> {
    const bytes = await this.fs.readFile(this.manifestPath(seq))
    const signature = await this.fs.readFile(`${this.manifestPath(seq)}.sig`)
    if (!bytes || !signature)
      return undefined

    try {
      return await verifyCoreManifest(bytes, new TextDecoder().decode(signature), this.options.trustedKeys)
    }
    catch (error) {
      if (error instanceof ErgosphereError)
        return undefined

      throw error
    }
  }

  private async update(change: (state: ClientState) => void): Promise<ClientState> {
    const state = await this.state()
    change(state)
    await saveState(this.fs, this.statePath, state)

    return state
  }
}
