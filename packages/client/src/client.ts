import type { Cadence, Component, CoreManifest, Distribution, Pointer, ShellArtifact, ShellManifest, TrustedKey } from '@ergosphere-it/protocol'

import type { Fetch, UpdateFileSystem } from './io'
import type { ClientState } from './state'

import { CandidateError, checkCoreCandidate, checkShellCandidate, DocumentError, ErgosphereError, isInRollout, SignatureError, verifyCoreManifest, verifyPointer, verifyShellManifest } from '@ergosphere-it/protocol'
import { errorMessageFrom } from '@moeru/std/error'
import { withRetry } from '@moeru/std/with-retry'
import { delay, sumBy } from 'es-toolkit'

import { DownloadError, downloadFile } from './download'
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
 * specification. `retry-later` means the core failed to download in this process, and the next attempt waits until
 * `retryAt`.
 */
export type CheckResult
  = | { current: number, seq: number, status: 'server-behind' }
    | { distribution: Distribution, status: 'disabled' }
    | { error: ErgosphereError, status: 'rejected' }
    | { manifest: CoreManifest, manifestBytes: Uint8Array<ArrayBuffer>, signature: string, status: 'available' }
    | { retryAt: string, seq: number, status: 'retry-later' }
    | { seq: number, status: 'not-in-cohort' }
    | { seq: number, status: 'not-in-rollout' }
    | { seq: number, status: 'up-to-date' }
    | { status: 'no-core' }

/** The result of a shell check. `feedUrl` is the electron-updater feed of this platform. */
export type ShellCheckResult
  = | { artifact: ShellArtifact, feedUrl: string, manifest: ShellManifest, status: 'available' }
    | { distribution: Distribution, status: 'disabled' }
    | { error: ErgosphereError, status: 'rejected' }
    | { status: 'up-to-date' }

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
  /** Objects to download at the same time. Defaults to 4. */
  concurrency?: number
  /** The directory that the client owns, for example `<userData>/updates`. */
  dataDir: string
  distribution: Distribution
  fetch?: Fetch
  fs: UpdateFileSystem
  /** The host that runs cores, for example `electron`. A core for another host is rejected. */
  host: string
  /** A request stops when no bytes arrive for this long. Defaults to 30 seconds. */
  idleTimeoutMs?: number
  /** Boots without a healthy report before a core is blocked. */
  maxBootAttempts?: number
  now?: () => Date
  /** The platform of this install, for example `darwin-arm64`. */
  platform: string
  /** The product of this install. Pointers and cores of another product are rejected, even with a valid signature. */
  product: string
  /** Retries of a failed object download in one stage. Each retry resumes the file. Defaults to 3. */
  retries?: number
  /** First wait before a retry. It doubles with each retry, up to 8 times this value. Defaults to 1 second. */
  retryDelayMs?: number
  shellHostApi: number
  /** The `seq` of the installed shell. Without it, the client does not check for shell updates. */
  shellSeq?: number
  trustedKeys: TrustedKey[]
}

const CODE_COMPONENTS = new Set<Component['type']>(['electron-main', 'electron-preload'])
const BUILTIN_KEY = 'builtin'
/** First wait before a core that failed to download is tried again. It doubles up to `MAX_FAILURE_DELAY_MS`. */
const FAILURE_DELAY_MS = 30_000
const MAX_FAILURE_DELAY_MS = 3_600_000
const POINTER_REUSE_MS = 10_000

/**
 * The update state machine of one install.
 *
 * It checks a channel pointer, stages a core into its data directory, selects the core to boot, and records health.
 * It never runs code. The host driver loads the selected core.
 */
export class UpdateClient {
  /**
   * The external core that this process booted. Its main code runs until the process exits, and the host can still
   * load files from its directory, for example a preload script or a lazy chunk. Reloads do not change it.
   */
  private booted: number | undefined
  private readonly concurrency: number
  /** Download failures of a core in this process, so a core that keeps failing waits longer between attempts. */
  private readonly failures = new Map<number, { count: number, retryAt: number }>()
  private readonly fetch: Fetch
  private readonly fs: UpdateFileSystem
  private readonly idleTimeoutMs: number
  /** The pointer of the last check, so a core check and a shell check in a row fetch it once. */
  private lastPointer: undefined | { at: number, pointer: Pointer }
  private readonly maxBootAttempts: number
  private readonly now: () => Date
  private readonly objects: ObjectStore
  private readonly options: UpdateClientOptions
  /** The tail of the state changes, so each change waits for the one before. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly retries: number

  private readonly retryDelayMs: number

  private get statePath(): string {
    return this.path('state.json')
  }

  constructor(options: UpdateClientOptions) {
    this.options = options
    this.fs = options.fs
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.now = options.now ?? (() => new Date())
    this.maxBootAttempts = options.maxBootAttempts ?? 3
    this.concurrency = options.concurrency ?? 4
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000
    this.retries = options.retries ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 1_000
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
      if (state.blocked.includes(seq))
        throw new CandidateError('blocked', `Core ${seq} is blocked on this install.`, seq)

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
    try {
      return await this.exclusive(() => this.selectBoot())
    }
    catch (error) {
      // NOTICE:
      // A file system error must not stop the app. The builtin core needs no state, so it boots without one.
      // For example, antivirus software on Windows can hold state.json during a rename and fail it with EPERM.
      // Removal condition: none. This is the last fallback of the boot order.
      this.booted = undefined
      const { builtin } = this.options
      const problem = `the update state is unavailable: ${errorMessageFrom(error) ?? 'unknown error'}`

      return { components: builtin.components, dir: builtin.dir, kind: 'builtin', rejected: [{ problem, seq: builtin.seq }], seq: builtin.seq, version: builtin.version }
    }
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

  /**
   * Checks the channel pointer for a newer shell, and returns its verified manifest and the installer for this platform.
   *
   * The host installs the shell with its platform installer, for example electron-updater with `feedUrl`. A rejection by
   * the protocol is a result. Network errors throw.
   */
  async checkShell(): Promise<ShellCheckResult> {
    const { baseUrl, distribution, platform, product, shellSeq, trustedKeys } = this.options
    if (distribution !== 'direct')
      return { distribution, status: 'disabled' }
    if (shellSeq === undefined)
      return { status: 'up-to-date' }

    try {
      const target = (await this.fetchPointer({ reuse: true })).shell?.seq
      if (target === undefined || target <= shellSeq)
        return { status: 'up-to-date' }

      const manifestUrl = `${baseUrl}/shells/${target}/shell.json`
      const manifest = await verifyShellManifest(await this.fetchBytes(manifestUrl), await this.fetchText(`${manifestUrl}.sig`), trustedKeys)
      if (manifest.seq !== target)
        throw new DocumentError('invalid-schema', `The shell manifest seq ${manifest.seq} is not the pointer seq ${target}.`)

      const artifact = checkShellCandidate(manifest, { host: this.options.host, platform, product, shellSeq })

      return { artifact, feedUrl: `${baseUrl}/shells/${target}/feeds/${platform}`, manifest, status: 'available' }
    }
    catch (error) {
      if (error instanceof ErgosphereError)
        return { error, status: 'rejected' }

      throw error
    }
  }

  /** Removes cores and objects that no kept core uses. It keeps the core that this process booted. */
  async collectGarbage(): Promise<void> {
    // A deferred core older than the current core can never boot.
    const state = await this.update((next) => {
      if (next.deferred !== undefined && next.deferred <= (next.current ?? 0))
        next.deferred = undefined
    })
    const keep = new Set([state.staged, state.current, state.previous, state.deferred, this.booted].filter((seq): seq is number => seq !== undefined))
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
    // Partial files of failed downloads. A later download of the same object starts again.
    for (const path of await this.objects.listPartial())
      await this.fs.remove(path)
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
    const result = await this.stageObjects(manifest, options)
    if (result.status === 'failed') {
      const count = (this.failures.get(manifest.seq)?.count ?? 0) + 1
      this.failures.set(manifest.seq, { count, retryAt: this.now().getTime() + Math.min(FAILURE_DELAY_MS * 2 ** (count - 1), MAX_FAILURE_DELAY_MS) })

      return result
    }
    this.failures.delete(manifest.seq)

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

    return { downloadedBytes: result.downloadedBytes, reusedBytes: result.reusedBytes, seq: manifest.seq, status: 'staged' }
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
    const { baseUrl, distribution, trustedKeys } = this.options
    if (distribution !== 'direct')
      return { distribution, status: 'disabled' }

    const pointer = await this.fetchPointer()
    const state = await this.state()
    if (!pointer.core)
      return { status: 'no-core' }

    const target = pointer.core.seq
    // A client never moves back. When the channel serves less than this install has, it reports that and waits for a
    // newer release.
    // A blocked core is not ahead. The install leaves it, so the channel can serve an older core again.
    const ahead = Math.max(...[state.current, state.staged].filter(seq => seq !== undefined && !state.blocked.includes(seq)) as number[], 0)
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

    // A download failure is not a bad release. Wait longer after each failure, but never block the core for it.
    const failure = this.failures.get(target)
    if (failure && this.now().getTime() < failure.retryAt)
      return { retryAt: new Date(failure.retryAt).toISOString(), seq: target, status: 'retry-later' }

    const manifestUrl = `${baseUrl}/cores/${target}/manifest.json`
    const manifestBytes = await this.fetchBytes(manifestUrl)
    const signature = await this.fetchText(`${manifestUrl}.sig`)
    const manifest = await verifyCoreManifest(manifestBytes, signature, trustedKeys)
    if (manifest.seq !== target)
      throw new DocumentError('invalid-schema', `The manifest seq ${manifest.seq} is not the pointer seq ${target}.`)

    checkCoreCandidate(manifest, {
      blocked: state.blocked,
      builtinSeq: this.options.builtin.seq,
      currentSeq: ahead || undefined,
      host: this.options.host,
      platform: this.options.platform,
      product: this.options.product,
      revoked: pointer.revoked,
      shellHostApi: this.options.shellHostApi,
    })

    return { manifest, manifestBytes, signature, status: 'available' }
  }

  /** Downloads one object into the store. Returns why it failed, or `undefined` when the object is stored. */
  private async downloadObject(hash: string, size: number, onBytes: (received: number) => void): Promise<string | undefined> {
    const part = this.objects.partPath(hash)
    const download = withRetry(async () => downloadFile({
      fetch: this.fetch,
      fs: this.fs,
      idleTimeoutMs: this.idleTimeoutMs,
      onBytes,
      path: part,
      size,
      url: `${this.options.baseUrl}/objects/sha256/${hash.slice(0, 2)}/${hash}`,
    }), {
      onError: (error) => {
        // withRetry retries every error. Stop early for errors that another attempt cannot fix.
        if (error instanceof DownloadError && !error.retryable)
          throw error
      },
      retry: this.retries,
      retryDelay: this.retryDelayMs,
      retryDelayMax: this.retryDelayMs * 8,
    })

    // A resumed file can hold bad bytes from an earlier attempt, so a mismatch gets one more download from the start.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await download()
      }
      catch (error) {
        return errorMessageFrom(error) ?? 'download failed'
      }
      if (await this.objects.adopt(hash, size, part))
        return undefined
    }

    return `downloaded bytes do not match sha256 ${hash}`
  }

  /** Runs state changes one at a time, so two changes never read the same state and lose one write. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run)
    this.queue = result.catch(() => {})

    return result
  }

  /** Fetches a small document, for example a pointer or a manifest. A stalled request fails after the idle timeout. */
  private async fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(this.idleTimeoutMs) })
    if (!response.ok)
      throw new Error(`GET ${url} returned ${response.status}`)

    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Fetches and verifies the channel pointer, and records its issue time and its revoked cores.
   *
   * With `reuse`, a pointer verified in the last few seconds is returned, so a shell check after a core check fetches it
   * once. A core check always fetches.
   */
  private async fetchPointer({ reuse = false } = {}): Promise<Pointer> {
    const now = this.now()
    if (reuse && this.lastPointer && now.getTime() - this.lastPointer.at < POINTER_REUSE_MS)
      return this.lastPointer.pointer

    const { baseUrl, cadence, channel, trustedKeys } = this.options
    const target = `${channel}/${cadence}`
    const state = await this.state()
    const pointerUrl = `${baseUrl}/pointers/${channel}/${cadence}.json`
    const fetchVerified = async () => verifyPointer(
      await this.fetchBytes(pointerUrl),
      await this.fetchText(`${pointerUrl}.sig`),
      trustedKeys,
      { cadence, channel, lastIssuedAt: state.pointerIssuedAt?.[target], now, product: this.options.product },
    )
    const pointer = await fetchVerified().catch(async (error: unknown) => {
      // A pointer and its signature are two files, so a fetch between their uploads can get a new pointer with the
      // old signature. Fetch both again once.
      if (!(error instanceof SignatureError) || error.code !== 'invalid-signature')
        throw error
      await delay(this.retryDelayMs)

      return fetchVerified()
    })
    await this.update((next) => {
      // A pointer issued in the future, for example by a CI runner with a fast clock, would make every later pointer
      // look replayed. Remember at most the time of this check.
      const issuedAt = Math.min(Date.parse(pointer.issuedAt), now.getTime())
      next.pointerIssuedAt = { ...next.pointerIssuedAt, [target]: new Date(issuedAt).toISOString() }
      for (const seq of pointer.revoked ?? []) {
        if (!next.blocked.includes(seq))
          next.blocked.push(seq)
      }
      // A staged core that is now revoked must not boot or activate.
      if (next.staged !== undefined && next.blocked.includes(next.staged))
        next.staged = undefined
    })
    this.lastPointer = { at: now.getTime(), pointer }

    return pointer
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
          if (await this.fs.hashFile(path) !== file.sha256)
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

  private async selectBoot(): Promise<BootSelection & { rejected: { problem: string, seq: number }[] }> {
    const state = await this.state()
    const rejected: { problem: string, seq: number }[] = []
    const accepted: { manifest: CoreManifest, seq: number }[] = []
    const seen = new Set<number>()
    // A deferred core waits for a newer shell. Try it again, because this shell can be the newer one.
    const deferred = state.deferred !== undefined && state.deferred > (state.current ?? 0) ? state.deferred : undefined

    for (const seq of [state.staged, deferred, state.current, state.previous]) {
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
      if (!result.permanent && (seq === state.staged || seq === deferred))
        state.deferred = seq
      else if (seq === state.deferred)
        state.deferred = undefined
    }

    const chosen = accepted[0]
    if (chosen && chosen.seq === state.deferred)
      state.deferred = undefined
    state.staged = undefined
    state.current = chosen?.seq
    state.previous = accepted[1]?.seq
    const key = chosen ? String(chosen.seq) : BUILTIN_KEY
    state.bootAttempts[key] = (state.bootAttempts[key] ?? 0) + 1
    await saveState(this.fs, this.statePath, state)
    this.booted = chosen?.seq

    if (chosen)
      return { components: chosen.manifest.components, dir: this.coreDir(chosen.seq), kind: 'external', rejected, seq: chosen.seq, version: chosen.manifest.version }

    const { builtin } = this.options

    return { components: builtin.components, dir: builtin.dir, kind: 'builtin', rejected, seq: builtin.seq, version: builtin.version }
  }

  /**
   * Puts every object of a manifest into the store: from the store, from a core on disk, or from the network.
   *
   * Downloads run in parallel, resume after a failure, and retry network errors with backoff. A file whose hash does
   * not match is downloaded once more from the start before the stage fails.
   */
  private async stageObjects(manifest: CoreManifest, options: StageOptions): Promise<Extract<StageResult, { status: 'failed' }> | { downloadedBytes: number, reusedBytes: number, status: 'stored' }> {
    const sources = await this.localSources()
    const missing = new Map<string, { path: string, size: number }>()
    let reusedBytes = 0

    // Phase 1: take every object that is already on disk, and list the objects to download.
    for (const component of manifest.components) {
      for (const file of component.files) {
        if (missing.has(file.sha256))
          continue
        if (await this.objects.hasValid(file.sha256, file.size)) {
          reusedBytes += file.size
          continue
        }

        const local = sources.get(file.sha256)
        if (local && await this.objects.copyIn(file.sha256, file.size, local)) {
          reusedBytes += file.size
          continue
        }

        missing.set(file.sha256, { path: file.path, size: file.size })
      }
    }

    // Phase 2: download the missing objects, a few at a time, and report progress against their total size.
    const totalBytes = sumBy([...missing.values()], object => object.size)
    const received = new Map<string, number>()
    const report = () => options.onProgress?.({ downloadedBytes: sumBy([...received.values()], bytes => bytes), totalBytes })
    report()

    let failure: Extract<StageResult, { status: 'failed' }> | undefined
    const queue = [...missing]
    const worker = async () => {
      for (let next = queue.shift(); next && !failure; next = queue.shift()) {
        const [hash, object] = next
        const problem = await this.downloadObject(hash, object.size, (bytes) => {
          received.set(hash, bytes)
          report()
        })
        if (problem)
          failure ??= { detail: problem, path: object.path, status: 'failed' }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker))
    if (failure)
      return failure

    return { downloadedBytes: totalBytes, reusedBytes, status: 'stored' }
  }

  private async update(change: (state: ClientState) => void): Promise<ClientState> {
    return this.exclusive(async () => {
      const state = await this.state()
      change(state)
      await saveState(this.fs, this.statePath, state)

      return state
    })
  }
}
