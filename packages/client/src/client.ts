import type { BundleManifest, ChannelFile, Component, InstallerArtifact, InstallerFormat, InstallerManifest, InstallerPackageType, TrustedKey } from '@ergosphere-it/protocol'

import type { Fetch, UpdateFileSystem } from './io'
import type { Locator } from './locate'
import type { BundleRef, ClientState, RollbackReason } from './state'

import { CandidateError, checkBundleCandidate, checkInstallerCandidate, DocumentError, ErgosphereError, isInRollout, SignatureError, verifyBundleManifest, verifyChannelFile, verifyInstallerManifest } from '@ergosphere-it/protocol'
import { newQueue } from '@henrygd/queue'
import { errorMessageFrom } from '@moeru/std/error'
import { withRetry } from '@moeru/std/with-retry'
import { delay, sumBy } from 'es-toolkit'

import { DownloadError, downloadFile } from './download'
import { createTreeLocator, locateDocument, locateFile } from './locate'
import { loadState, saveState } from './state'
import { ObjectStore } from './store'

/** The bundle that the client selected to boot. */
export interface BootSelection {
  components: Component[]
  dir: string
  /** True for the bundle that came with the installer. */
  fromInstaller: boolean
  releaseId: number
  version: string
}

export interface CheckOptions {
  /** Checks now, also when an earlier download failure scheduled a retry for later. Use it for a manual check. */
  force?: boolean
}

/**
 * The result of a bundle check.
 *
 * - `available`: a verified bundle that this install can take.
 * - `needs-newer-native-version`: the channel serves a verified bundle that needs a newer native version than this
 *   install has. Only a new installer can take the app to it, so the host offers an installer or asks for a manual install.
 * - `up-to-date`: nothing to take. `detail` says why, for logs and support. Users see "up to date" in every case.
 * - `retry-scheduled`: the bundle failed to download in this process. The next check waits until `retryAt`, unless it
 *   is forced.
 * - `verification-failed`: the channel file or the bundle manifest failed a protocol check, for example its signature.
 */
export type CheckResult
  = | { detail?: UpToDateDetail, status: 'up-to-date' }
    | { error: ErgosphereError, releaseId?: number, status: 'verification-failed' }
    | { error: string, manifest: BundleManifest, retryAt: Date, status: 'retry-scheduled' }
    | { manifest: BundleManifest, manifestBytes: Uint8Array<ArrayBuffer>, signature: string, status: 'available' }
    | { manifest: BundleManifest, status: 'needs-newer-native-version' }

/** The installed app, for installer checks. */
export interface InstalledApp {
  /** The installer formats that the app can install, the preferred format first. */
  formats: readonly InstallerFormat[]
  /** On Linux, the package that the app came in, so it takes the installer file of the same package. */
  packageType?: InstallerPackageType
  /** The release ID of the installer that installed the app. */
  releaseId: number
}

/** The bundle that ships inside the installer. The installer is signed, so the client trusts it without a signature. */
export interface InstallerBundle {
  components: Component[]
  dir: string
  releaseId: number
  version: string
}

/** The result of an installer check. */
export type InstallerCheckResult
  = | { artifact: InstallerArtifact, manifest: InstallerManifest, status: 'available' }
    | { error: ErgosphereError, status: 'verification-failed' }
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
  = | { detail: string, path: string, retryAt: Date, status: 'failed' }
    | { downloadedBytes: number, releaseId: number, reusedBytes: number, status: 'staged' }

export interface UpdateClientOptions {
  channel: string
  /** Cohorts of this install. A channel file with cohorts serves only those cohorts, and the cohort `all`. */
  cohorts?: readonly string[]
  /** Objects to download at the same time. Defaults to 4. */
  concurrency?: number
  /** The directory that the client owns, for example `<userData>/updates`. */
  dataDir: string
  /** The URL of the static update server. The default locator reads the file tree under it. */
  feedUrl: string
  fetch?: Fetch
  fs: UpdateFileSystem
  /** The host that runs bundles, for example `electron`. A bundle for another host is rejected. */
  host: string
  /** A request stops when no bytes arrive for this long. Defaults to 30 seconds. */
  idleTimeoutMs?: number
  /** The installed app. Without it, the client does not check for installer updates. */
  installedApp?: InstalledApp
  installerBundle: InstallerBundle
  /**
   * Tells the client where each file is, for example with a lookup on a release server. Defaults to the file tree
   * under `feedUrl`. Locations carry no trust, so the checks do not change.
   */
  locate?: Locator
  /** Boots without a healthy report before a bundle is blocked. */
  maxBootAttempts?: number
  /** The native version of this install. A bundle runs only when its range includes it. */
  nativeVersion: number
  now?: () => Date
  /** The platform of this install, for example `darwin-arm64`. */
  platform: string
  /** The product of this install. Channel files and bundles of another product are rejected, even with a valid signature. */
  product: string
  /** Retries of a failed object download in one stage. Each retry resumes the file. Defaults to 3. */
  retries?: number
  /** First wait before a retry. It doubles with each retry, up to 8 times this value. Defaults to 1 second. */
  retryDelayMs?: number
  trustedKeys: TrustedKey[]
}

/** Why a check found nothing to take. */
export type UpToDateDetail = 'app-newer-than-feed' | 'not-in-cohort' | 'not-in-rollout' | 'nothing-published'

const CODE_COMPONENTS = new Set<Component['type']>(['electron-main', 'electron-preload'])
const INSTALLER_KEY = 'installer'
/** First wait before a bundle that failed to download is tried again. It doubles up to `MAX_FAILURE_DELAY_MS`. */
const FAILURE_DELAY_MS = 30_000
const MAX_FAILURE_DELAY_MS = 3_600_000
const CHANNEL_FILE_REUSE_MS = 10_000

/**
 * The update state machine of one install.
 *
 * It checks a channel file, stages a bundle into its data directory, selects the bundle to boot, and records health.
 * It never runs code. The host driver loads the selected bundle.
 */
export class UpdateClient {
  /**
   * The downloaded bundle that this process booted. Its main code runs until the process exits, and the host can still
   * load files from its directory, for example a preload script or a lazy chunk. Reloads do not change it.
   */
  private booted: number | undefined
  private readonly concurrency: number
  /** Download failures of a bundle in this process, so a bundle that keeps failing waits longer between attempts. */
  private readonly failures = new Map<number, { count: number, error: string, manifest: BundleManifest, retryAt: number }>()
  private readonly fetch: Fetch
  private readonly fs: UpdateFileSystem
  private readonly idleTimeoutMs: number
  /** The channel file of the last check, so a bundle check and an installer check in a row fetch it once. */
  private lastChannelFile: undefined | { at: number, file: ChannelFile }
  private readonly locate: Locator
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
    this.locate = options.locate ?? createTreeLocator(options.feedUrl)
    this.now = options.now ?? (() => new Date())
    this.maxBootAttempts = options.maxBootAttempts ?? 3
    this.concurrency = options.concurrency ?? 4
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000
    this.retries = options.retries ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 1_000
    this.objects = new ObjectStore(this.fs, this.path('objects', 'sha256'))
  }

  /**
   * Makes the staged bundle current without a restart, for a change that only reloads pages.
   *
   * The bundle that ran before becomes `previous`, so `rollback` can return to it.
   */
  async activateInPlace(releaseId: number): Promise<void> {
    await this.update((state) => {
      if (state.staged !== releaseId)
        throw new Error(`activateInPlace: bundle ${releaseId} is not staged`)
      if (state.blocked.includes(releaseId))
        throw new CandidateError('blocked', `Bundle ${releaseId} is blocked on this install.`, releaseId)

      state.previous = state.current
      state.current = releaseId
      state.staged = undefined
    })
  }

  /**
   * Selects the bundle to boot: staged, then current, then previous, then the bundle of the installer.
   *
   * The first boot of an installer that a check found hands the install off to it: it leaves every stored bundle except
   * the bundle that the channel served at that check. A bundle of another channel can be newer than the installer, and
   * otherwise boots in its place.
   *
   * It counts the boot attempt of the selected bundle. The host must call `markHealthy` when the app works.
   *
   * With `readOnly`, it selects the same bundle without a change to the state, for example in a second instance of the
   * app, which must not count a boot attempt of the first one.
   */
  async boot({ readOnly = false }: { readOnly?: boolean } = {}): Promise<BootSelection & { rejected: { problem: string, releaseId: number }[] }> {
    try {
      return await this.exclusive(() => this.selectBoot(readOnly))
    }
    catch (error) {
      // NOTICE:
      // A file system error must not stop the app. The installer bundle needs no state, so it boots without one.
      // For example, antivirus software on Windows can hold state.json during a rename and fail it with EPERM.
      // Removal condition: none. This is the last fallback of the boot order.
      this.booted = undefined
      const problem = `the update state is unavailable: ${errorMessageFrom(error) ?? 'unknown error'}`

      return { ...this.installerSelection(), rejected: [{ problem, releaseId: this.options.installerBundle.releaseId }] }
    }
  }

  bundleDir(releaseId: number): string {
    return this.path('bundles', String(releaseId))
  }

  /**
   * Checks the channel file and returns a verified bundle that this install can take.
   *
   * A protocol rejection is a result, not an error. Network and file system errors throw.
   */
  async check(options: CheckOptions = {}): Promise<CheckResult> {
    try {
      return await this.checkChannel(options)
    }
    catch (error) {
      if (!(error instanceof ErgosphereError))
        throw error

      return { error, releaseId: error instanceof CandidateError ? error.releaseId : undefined, status: 'verification-failed' }
    }
  }

  /**
   * Checks the channel file for a newer installer, and returns its verified manifest and the file for this platform in
   * the first format that the app takes.
   *
   * A protocol rejection is a result. Network errors throw. A withdrawn installer is a rejection, and `state().withdrawn`
   * lists it, so the host can drop a download of it.
   */
  async checkInstaller(): Promise<InstallerCheckResult> {
    const { installedApp, platform, product, trustedKeys } = this.options
    if (installedApp === undefined)
      return { status: 'up-to-date' }

    try {
      const channelFile = await this.fetchChannelFile({ reuse: true })
      const target = channelFile.installer?.releaseId
      if (target === undefined || target <= installedApp.releaseId)
        return { status: 'up-to-date' }

      const location = await locateDocument(this.locate, { kind: 'installer', releaseId: target })
      const manifest = await verifyInstallerManifest(await this.fetchBytes(location.url), await this.fetchText(location.signature), trustedKeys)
      if (manifest.releaseId !== target)
        throw new DocumentError('invalid-schema', `The installer manifest releaseId ${manifest.releaseId} is not the channel releaseId ${target}.`)

      const artifact = checkInstallerCandidate(manifest, {
        formats: installedApp.formats,
        host: this.options.host,
        installerReleaseId: installedApp.releaseId,
        packageType: installedApp.packageType,
        platform,
        product,
        withdrawn: channelFile.withdrawn,
      })
      const channelBundleReleaseId = channelFile.bundle?.releaseId
      const handoff = (await this.state()).installerHandoff
      if (handoff?.installerReleaseId !== target || handoff.channelBundleReleaseId !== channelBundleReleaseId) {
        await this.update((next) => {
          next.installerHandoff = { channelBundleReleaseId, installerReleaseId: target }
        })
      }

      return { artifact, manifest, status: 'available' }
    }
    catch (error) {
      if (error instanceof ErgosphereError)
        return { error, status: 'verification-failed' }

      throw error
    }
  }

  /** Removes bundles and objects that no kept bundle uses. It keeps the bundle that this process booted. */
  async collectGarbage(): Promise<void> {
    // A deferred bundle older than the current bundle can never boot.
    const state = await this.update((next) => {
      if (next.deferred !== undefined && next.deferred <= (next.current ?? 0))
        next.deferred = undefined
    })
    const keep = new Set([state.staged, state.current, state.previous, state.deferred, this.booted].filter((id): id is number => id !== undefined))
    const used = new Set<string>()

    for (const name of await this.fs.list(this.path('bundles'))) {
      if (!keep.has(Number(name)))
        await this.fs.remove(this.path('bundles', name))
    }
    for (const name of await this.fs.list(this.path('manifests'))) {
      if (!keep.has(Number(name.split('.')[0])))
        await this.fs.remove(this.path('manifests', name))
    }
    for (const releaseId of keep) {
      const manifest = await this.readStoredManifest(releaseId)
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

  /** Forgets the last rollback, after the app told the user. */
  async dismissRollback(): Promise<void> {
    await this.update((state) => {
      state.rolledBack = undefined
    })
  }

  /** Records that the bundle works. It clears the boot attempts of that bundle. */
  async markHealthy(selection: BootSelection): Promise<void> {
    await this.update((state) => {
      state.bootAttempts[selection.fromInstaller ? INSTALLER_KEY : String(selection.releaseId)] = 0
    })
  }

  /**
   * Blocks a bundle that failed and points the install back to the previous bundle.
   *
   * Returns the release ID to run next, or `undefined` for the bundle of the installer.
   */
  async rollback(releaseId: number, reason: RollbackReason): Promise<number | undefined> {
    // Name both bundles first, so the state changes in one write. Each write flushes to disk, which is slow on Windows.
    const before = await this.state()
    const target = before.current === releaseId ? before.previous : before.current
    const [from, to] = await Promise.all([this.bundleRef(releaseId), this.bundleRef(target)])
    const state = await this.update((next) => {
      if (!next.blocked.includes(releaseId))
        next.blocked.push(releaseId)
      if (next.staged === releaseId)
        next.staged = undefined
      if (next.current === releaseId) {
        next.current = next.previous
        next.previous = undefined
      }
      next.rolledBack = { from, reason, to }
    })

    return state.current
  }

  /** Downloads the missing objects of a checked bundle, builds its directory, and marks it as staged. */
  async stage(available: Extract<CheckResult, { status: 'available' }>, options: StageOptions = {}): Promise<StageResult> {
    const { manifest, manifestBytes, signature } = available
    const { releaseId } = manifest
    const result = await this.stageObjects(manifest, options)
    if (result.status === 'failed') {
      const count = (this.failures.get(releaseId)?.count ?? 0) + 1
      const retryAt = this.now().getTime() + Math.min(FAILURE_DELAY_MS * 2 ** (count - 1), MAX_FAILURE_DELAY_MS)
      this.failures.set(releaseId, { count, error: `${result.path}: ${result.detail}`, manifest, retryAt })

      return { ...result, retryAt: new Date(retryAt) }
    }
    this.failures.delete(releaseId)

    const target = this.bundleDir(releaseId)
    const building = this.path('bundles', `.building-${releaseId}`)
    await this.fs.remove(building)
    for (const component of manifest.components) {
      for (const file of component.files)
        await this.fs.copyFile(this.objects.pathOf(file.sha256), this.fs.join(building, ...file.path.split('/')))
    }
    await this.fs.remove(target)
    await this.fs.rename(building, target)
    await this.fs.writeFileAtomic(this.manifestPath(releaseId), manifestBytes)
    await this.fs.writeFileAtomic(`${this.manifestPath(releaseId)}.sig`, new TextEncoder().encode(signature))

    await this.update((next) => {
      next.staged = releaseId
      if (next.deferred === releaseId)
        next.deferred = undefined
      // A newer bundle replaces the story of the last rollback.
      if (next.rolledBack && releaseId > next.rolledBack.from.releaseId)
        next.rolledBack = undefined
    })
    await this.collectGarbage()

    return { downloadedBytes: result.downloadedBytes, releaseId, reusedBytes: result.reusedBytes, status: 'staged' }
  }

  async state(): Promise<ClientState> {
    return loadState(this.fs, this.statePath)
  }

  /** Returns a stored bundle after it verifies its manifest, without a boot attempt. `undefined` gives the installer bundle. */
  async storedBundle(releaseId: number | undefined): Promise<BootSelection | undefined> {
    if (releaseId === undefined)
      return this.installerSelection()

    const manifest = await this.readStoredManifest(releaseId)

    return manifest ? { components: manifest.components, dir: this.bundleDir(releaseId), fromInstaller: false, releaseId, version: manifest.version } : undefined
  }

  /** Names a stored bundle by release and version. `undefined` names the bundle of the installer. */
  private async bundleRef(releaseId: number | undefined): Promise<BundleRef> {
    if (releaseId === undefined || releaseId === this.options.installerBundle.releaseId)
      return { fromInstaller: true, releaseId: this.options.installerBundle.releaseId, version: this.options.installerBundle.version }

    return { fromInstaller: false, releaseId, version: (await this.readStoredManifest(releaseId))?.version ?? String(releaseId) }
  }

  private async checkChannel({ force = false }: CheckOptions): Promise<CheckResult> {
    const { trustedKeys } = this.options
    const channelFile = await this.fetchChannelFile()
    const state = await this.state()
    const served = channelFile.bundle
    if (!served)
      return { detail: 'nothing-published', status: 'up-to-date' }

    const target = served.releaseId
    // A client never moves back. When the channel serves less than this install has, it reports that and waits for a
    // newer release.
    // A blocked bundle is not ahead. The install leaves it, so the channel can serve an older bundle again.
    const ahead = Math.max(...[state.current, state.staged].filter(id => id !== undefined && !state.blocked.includes(id)) as number[], 0)
    if (target < ahead)
      return { detail: 'app-newer-than-feed', status: 'up-to-date' }

    const floor = Math.max(this.options.installerBundle.releaseId, ahead)
    // A blocked or withdrawn bundle stays blocked, so skip its manifest. Otherwise every check downloads it again.
    if (target <= floor || state.blocked.includes(target))
      return { status: 'up-to-date' }
    if (served.cohorts && !['all', ...this.options.cohorts ?? []].some(cohort => served.cohorts!.includes(cohort)))
      return { detail: 'not-in-cohort', status: 'up-to-date' }
    if (!await isInRollout(served.rollout, state.installId))
      return { detail: 'not-in-rollout', status: 'up-to-date' }

    // A download failure is not a bad release. Wait longer after each failure, but never block the bundle for it.
    const failure = this.failures.get(target)
    if (failure && !force && this.now().getTime() < failure.retryAt)
      return { error: failure.error, manifest: failure.manifest, retryAt: new Date(failure.retryAt), status: 'retry-scheduled' }

    const location = await locateDocument(this.locate, { kind: 'bundle', releaseId: target })
    const manifestBytes = await this.fetchBytes(location.url)
    const signature = await this.fetchText(location.signature)
    const manifest = await verifyBundleManifest(manifestBytes, signature, trustedKeys)
    if (manifest.releaseId !== target)
      throw new DocumentError('invalid-schema', `The manifest releaseId ${manifest.releaseId} is not the channel releaseId ${target}.`)

    try {
      checkBundleCandidate(manifest, {
        blocked: state.blocked,
        currentReleaseId: ahead || undefined,
        host: this.options.host,
        installerBundleReleaseId: this.options.installerBundle.releaseId,
        nativeVersion: this.options.nativeVersion,
        platform: this.options.platform,
        product: this.options.product,
        withdrawn: channelFile.withdrawn,
      })
    }
    catch (error) {
      if (error instanceof CandidateError && error.code === 'native-version-mismatch')
        return { manifest, status: 'needs-newer-native-version' }

      throw error
    }

    return { manifest, manifestBytes, signature, status: 'available' }
  }

  /** Downloads one object into the store. Returns why it failed, or `undefined` when the object is stored. */
  private async downloadObject(releaseId: number, hash: string, size: number, onBytes: (received: number) => void): Promise<string | undefined> {
    const part = this.objects.partPath(hash)
    let url: string
    try {
      url = await locateFile(this.locate, { kind: 'object', releaseId, sha256: hash, size })
    }
    catch (error) {
      return `the locator found no URL: ${errorMessageFrom(error) ?? 'unknown error'}`
    }
    const download = withRetry(async () => downloadFile({
      fetch: this.fetch,
      fs: this.fs,
      idleTimeoutMs: this.idleTimeoutMs,
      onBytes,
      path: part,
      size,
      url,
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

  /** Fetches a small document, for example a channel file or a manifest. A stalled request fails after the idle timeout. */
  private async fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(this.idleTimeoutMs) })
    if (!response.ok)
      throw new Error(`GET ${url} returned ${response.status}`)

    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Fetches and verifies the channel file, and records its issue time and its withdrawn bundles.
   *
   * With `reuse`, a channel file verified in the last few seconds is returned, so an installer check after a bundle
   * check fetches it once. A bundle check always fetches.
   */
  private async fetchChannelFile({ reuse = false } = {}): Promise<ChannelFile> {
    const now = this.now()
    if (reuse && this.lastChannelFile && now.getTime() - this.lastChannelFile.at < CHANNEL_FILE_REUSE_MS)
      return this.lastChannelFile.file

    const { channel, trustedKeys } = this.options
    const state = await this.state()
    const location = await locateDocument(this.locate, { channel, kind: 'channel' })
    const fetchVerified = async () => verifyChannelFile(
      await this.fetchBytes(location.url),
      await this.fetchText(location.signature),
      trustedKeys,
      { channel, lastIssuedAt: state.channelIssuedAt?.[channel], now, product: this.options.product },
    )
    const file = await fetchVerified().catch(async (error: unknown) => {
      // A channel file and its signature are two files, so a fetch between their uploads can get a new file with the
      // old signature. Fetch both again once.
      if (!(error instanceof SignatureError) || error.code !== 'invalid-signature')
        throw error
      await delay(this.retryDelayMs)

      return fetchVerified()
    })
    await this.update((next) => {
      // A file issued in the future, for example by a CI runner with a fast clock, would make every later file look
      // replayed. Remember at most the time of this check.
      const issuedAt = Math.min(Date.parse(file.issuedAt), now.getTime())
      next.channelIssuedAt = { ...next.channelIssuedAt, [channel]: new Date(issuedAt).toISOString() }
      for (const releaseId of file.withdrawn ?? []) {
        if (!next.blocked.includes(releaseId))
          next.blocked.push(releaseId)
        if (!next.withdrawn.includes(releaseId))
          next.withdrawn.push(releaseId)
      }
      // A staged bundle that is now withdrawn must not boot or activate.
      if (next.staged !== undefined && next.blocked.includes(next.staged))
        next.staged = undefined
    })
    this.lastChannelFile = { at: now.getTime(), file }

    return file
  }

  private async fetchText(url: string): Promise<string> {
    return new TextDecoder().decode(await this.fetchBytes(url))
  }

  /**
   * On the first boot of the installer of the handoff, leaves every bundle except the bundle that the channel served.
   *
   * For example, an install on `dev` runs a dev bundle that is newer than the canary installer. The user moves to
   * `canary` and installs its installer. Without this, the dev bundle boots again, and the install never leaves `dev`.
   */
  private handOffToInstaller(state: ClientState): void {
    const handoff = state.installerHandoff
    const installed = this.options.installedApp?.releaseId
    if (!handoff || installed === undefined || installed < handoff.installerReleaseId)
      return

    if (installed === handoff.installerReleaseId) {
      for (const key of ['staged', 'deferred', 'current', 'previous'] as const) {
        if (state[key] !== handoff.channelBundleReleaseId)
          state[key] = undefined
      }
    }
    state.installerHandoff = undefined
  }

  /** Checks one stored bundle before boot. Returns the reason it cannot boot, or `undefined`. */
  private async inspect(releaseId: number, state: ClientState): Promise<{ manifest?: BundleManifest, permanent?: boolean, problem?: string }> {
    const manifest = await this.readStoredManifest(releaseId)
    if (!manifest)
      return { permanent: true, problem: 'manifest is missing or does not verify' }

    try {
      checkBundleCandidate(manifest, {
        blocked: state.blocked,
        host: this.options.host,
        installerBundleReleaseId: this.options.installerBundle.releaseId,
        nativeVersion: this.options.nativeVersion,
        platform: this.options.platform,
        product: this.options.product,
        withdrawn: state.withdrawn,
      })
    }
    catch (error) {
      if (!(error instanceof CandidateError))
        throw error

      return { manifest, permanent: error.code !== 'native-version-mismatch', problem: error.code }
    }

    const dir = this.bundleDir(releaseId)
    for (const component of manifest.components) {
      for (const file of component.files) {
        const path = this.fs.join(dir, ...file.path.split('/'))
        if (await this.fs.fileSize(path) !== file.size)
          return { manifest, permanent: true, problem: `file ${file.path} is missing or has the wrong size` }

        // NOTICE:
        // Code files are hashed on every boot. Large web assets are checked by size only.
        // Hashing every file adds about 600 ms to a cold start (measured by LobeHub Desktop).
        // The client hashed every object when it stored it, and nothing else writes to the bundle directory.
        // Remove this split when hashing all files at boot costs less than 100 ms.
        if (CODE_COMPONENTS.has(component.type)) {
          if (await this.fs.hashFile(path) !== file.sha256)
            return { manifest, permanent: true, problem: `file ${file.path} does not match its hash` }
        }
      }
    }

    if ((state.bootAttempts[String(releaseId)] ?? 0) >= this.maxBootAttempts)
      return { manifest, permanent: true, problem: 'not-marked-healthy' }

    return { manifest }
  }

  private installerSelection(): BootSelection {
    const { components, dir, releaseId, version } = this.options.installerBundle

    return { components, dir, fromInstaller: true, releaseId, version }
  }

  /** Paths of files on disk that can give an object without a download: the running bundle and the installer bundle. */
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
    for (const releaseId of [state.current, state.previous]) {
      if (releaseId === undefined)
        continue

      const manifest = await this.readStoredManifest(releaseId)
      if (manifest)
        add(this.bundleDir(releaseId), manifest.components)
    }
    add(this.options.installerBundle.dir, this.options.installerBundle.components)

    return sources
  }

  private manifestPath(releaseId: number): string {
    return this.path('manifests', `${releaseId}.json`)
  }

  private path(...parts: string[]): string {
    return this.fs.join(this.options.dataDir, ...parts)
  }

  private async readStoredManifest(releaseId: number): Promise<BundleManifest | undefined> {
    const bytes = await this.fs.readFile(this.manifestPath(releaseId))
    const signature = await this.fs.readFile(`${this.manifestPath(releaseId)}.sig`)
    if (!bytes || !signature)
      return undefined

    try {
      return await verifyBundleManifest(bytes, new TextDecoder().decode(signature), this.options.trustedKeys)
    }
    catch (error) {
      if (error instanceof ErgosphereError)
        return undefined

      throw error
    }
  }

  private async selectBoot(readOnly: boolean): Promise<BootSelection & { rejected: { problem: string, releaseId: number }[] }> {
    const state = await this.state()
    this.handOffToInstaller(state)
    const rejected: { problem: string, releaseId: number }[] = []
    const accepted: { manifest: BundleManifest, releaseId: number }[] = []
    const seen = new Set<number>()
    const versions = new Map<number, string>()
    // A deferred bundle waits for a newer native version. Try it again, because this install can be the newer one.
    const deferred = state.deferred !== undefined && state.deferred > (state.current ?? 0) ? state.deferred : undefined

    for (const releaseId of [state.staged, deferred, state.current, state.previous]) {
      if (releaseId === undefined || seen.has(releaseId))
        continue

      seen.add(releaseId)
      const result = await this.inspect(releaseId, state)
      if (result.manifest)
        versions.set(releaseId, result.manifest.version)
      if (result.problem === undefined && result.manifest) {
        accepted.push({ manifest: result.manifest, releaseId })
        continue
      }

      rejected.push({ problem: result.problem ?? 'unknown', releaseId })
      if (result.permanent && !state.blocked.includes(releaseId))
        state.blocked.push(releaseId)
      if (!result.permanent && (releaseId === state.staged || releaseId === deferred))
        state.deferred = releaseId
      else if (releaseId === state.deferred)
        state.deferred = undefined
    }

    const chosen = accepted[0]
    // The bundle that ran last does not boot now. Record why, so the app can tell the user after the restart.
    const left = rejected.find(item => item.releaseId === state.current && (item.problem === 'not-marked-healthy' || item.problem === 'withdrawn'))
    if (left) {
      state.rolledBack = {
        from: { fromInstaller: false, releaseId: left.releaseId, version: versions.get(left.releaseId) ?? String(left.releaseId) },
        reason: left.problem as RollbackReason,
        to: chosen ? { fromInstaller: false, releaseId: chosen.releaseId, version: chosen.manifest.version } : await this.bundleRef(undefined),
      }
    }

    if (chosen && chosen.releaseId === state.deferred)
      state.deferred = undefined
    state.staged = undefined
    state.current = chosen?.releaseId
    state.previous = accepted[1]?.releaseId
    const key = chosen ? String(chosen.releaseId) : INSTALLER_KEY
    state.bootAttempts[key] = (state.bootAttempts[key] ?? 0) + 1
    if (!readOnly)
      await saveState(this.fs, this.statePath, state)
    this.booted = chosen?.releaseId

    if (chosen)
      return { components: chosen.manifest.components, dir: this.bundleDir(chosen.releaseId), fromInstaller: false, rejected, releaseId: chosen.releaseId, version: chosen.manifest.version }

    return { ...this.installerSelection(), rejected }
  }

  /**
   * Puts every object of a manifest into the store: from the store, from a bundle on disk, or from the network.
   *
   * Downloads run in parallel, resume after a failure, and retry network errors with backoff. A file whose hash does
   * not match is downloaded once more from the start before the stage fails.
   */
  private async stageObjects(manifest: BundleManifest, options: StageOptions): Promise<{ detail: string, path: string, status: 'failed' } | { downloadedBytes: number, reusedBytes: number, status: 'stored' }> {
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

    // The first failed download stops the start of new downloads. A download that fails reports a problem, and one
    // that throws stops the stage with its error.
    let failure: undefined | { detail: string, path: string, status: 'failed' }
    let thrown: undefined | { error: unknown }
    const downloads = newQueue(this.concurrency)
    for (const [hash, object] of missing) {
      downloads.add(async () => {
        const problem = await this.downloadObject(manifest.releaseId, hash, object.size, (bytes) => {
          received.set(hash, bytes)
          report()
        })
        if (problem && !failure) {
          failure = { detail: problem, path: object.path, status: 'failed' }
          downloads.clear()
        }
      }).catch((error: unknown) => {
        // clear() rejects the downloads that did not start. Keep the first error of a download that ran.
        if (failure || thrown)
          return

        thrown = { error }
        downloads.clear()
      })
    }
    await downloads.done()
    if (thrown)
      throw thrown.error
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
