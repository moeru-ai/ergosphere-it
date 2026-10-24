// Shared helpers of e2e.ts and demo.ts: a release workspace and the process of the test build of the example app.

import type { ChildProcess } from 'node:child_process'

import type { LauncherEvent, UpdaterStatus } from '@ergosphere-it/electron/launcher'
import type { ChannelFile, NativeVersionRange, SigningKey, TrustedKey } from '@ergosphere-it/protocol'
import type { BundleRelease, InstallerRelease, TreeFile } from '@ergosphere-it/publish'

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { arch, env, kill, platform } from 'node:process'

import electronPath from 'electron'

import { createPackage } from '@electron/asar'
import { bundleReleaseFromBuild } from '@ergosphere-it/electron/release'
import { createKeyPair } from '@ergosphere-it/protocol'
import { buildChannelFile, buildInstallerRelease, reissueChannelFile, uploadStages } from '@ergosphere-it/publish'
import { MemoryTree } from '@ergosphere-it/server'
import { build as viteBuild } from 'electron-vite'
import { delay } from 'es-toolkit'

const appRoot = join(import.meta.dirname, '..')

// NOTICE:
// In Node.js, the `electron` package exports the path of the Electron binary.
// Its types describe the Electron API of the main process instead.
// See node_modules/electron/index.js and electron.d.ts.
// Remove the cast when the package types the Node.js export.
const electronBinary = electronPath as unknown as string

/** An event of the test build: a launcher event, or a test event of `src/main.ts`. */
export type AppEvent
  = | LauncherEvent
    | { mainTag: string, releaseId: number, type: 'bundle-main' }
    | { releaseId: number, type: 'page-mounted', version: string }

export interface BuildOptions {
  /** Build the installed app, so Electron starts it. */
  installed?: boolean
  /** Native versions that can run the bundle. Defaults to the native version of the build. */
  nativeVersion?: NativeVersionRange
}

export interface LaunchOptions {
  /** Applies every ready update, as a user who clicks the button does. Defaults to true. */
  applyAll?: boolean
  /** Saves a screenshot after each page loads. */
  capture?: string
  checkMs?: number
  debugPort?: string
  /** Installs with the installer of the e2e test, which downloads and quits instead of installing. */
  e2eInstaller?: boolean
  feedUrl: string
  healthMs?: number
  show?: boolean
}

/** An event with the process and the time of its log line. */
export type LoggedEvent = AppEvent & { pid: number, time: number }

/**
 * One test build of the example app. `label` is the version and changes the page, and `mainTag` changes the main code.
 * `assetMb` adds a page asset. `crash` and `noHealth` build a broken bundle.
 */
export interface Variant {
  assetMb?: number
  crash?: boolean
  label: string
  mainTag?: string
  noHealth?: boolean
}

export interface WorkspaceOptions {
  /** Pack the app into `app.asar`, as installers do. */
  asar?: boolean
  /** Keep the tree in the work directory, so the next run continues from it. */
  persist?: boolean
}

/**
 * A memory tree that also writes each file to a directory, and loads them again at start.
 *
 * It shows a backend mapping: the publish API gives files, and the host decides where they go. A real host puts them
 * in an object store instead.
 */
class DiskTree extends MemoryTree {
  private readonly dir: string

  constructor(dir: string) {
    super()
    this.dir = dir
    const index = join(dir, 'index.json')
    if (!existsSync(index))
      return

    const meta = JSON.parse(readFileSync(index, 'utf8')) as Record<string, Pick<TreeFile, 'headers' | 'immutable'>>
    super.put(Object.entries(meta).map(([key, file]) => ({ ...file, bytes: new Uint8Array(readFileSync(join(dir, 'files', ...key.split('/')))), key })))
  }

  override put(files: Iterable<TreeFile>): void {
    const list = [...files]
    super.put(list)
    for (const file of list) {
      const path = join(this.dir, 'files', ...file.key.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.bytes)
    }
    const index = Object.fromEntries(this.entries().map(file => [file.key, { headers: file.headers, immutable: file.immutable }]))
    writeFileSync(join(this.dir, 'index.json'), `${JSON.stringify(index)}\n`)
  }
}

/**
 * A release workspace: a signing key, an update tree in memory, the installed test build, and the app event log.
 *
 * `work` is a scratch directory for keys, logs, app data, and builds. The installed app lives in
 * `tests/electron/.work/<id>`: the package manifest and the installed build. Module resolution walks up from there to
 * the `node_modules` of the test package, so the app needs no link. A demo and an e2e run never share files. With
 * `persist`, the tree is also kept in `work`, so the next run continues from it.
 */
export class Workspace {
  /** The directory of the installed app, as an installer would lay it out. */
  readonly appDir: string
  /** Pack the app into `app.asar`, as installers do, so the installer bundle is read from the archive. */
  readonly asar: boolean
  /** The event log of the app, one JSON event per line. */
  readonly logFile: string
  /** The product of the test build, from its package name. Channel files and installers must name it. */
  product = ''
  readonly signingKey: SigningKey
  readonly tree: MemoryTree
  readonly trustedKey: TrustedKey
  readonly userData: string
  readonly work: string

  /** What Electron starts: the archive, or the app directory. */
  get launchTarget(): string {
    return this.asar ? join(this.appDir, 'app.asar') : this.appDir
  }

  /** The directory with the package manifest and the installed build. With `asar`, it is packed into the app directory. */
  private get appSource(): string {
    return this.asar ? join(this.work, 'app-source') : this.appDir
  }

  private constructor(work: string, signingKey: SigningKey, trustedKey: TrustedKey, { asar = false, persist = false }: WorkspaceOptions) {
    this.work = work
    // NOTICE:
    // The installed app lives inside the test package, not in `work`, so dependencies resolve without a link.
    // A junction from `work` to the `node_modules` of the package broke on Windows: pnpm links packages with relative
    // symbolic links, and Windows resolved them from the junction path, so `@guiiai/logg` was not found.
    // Source: the e2e run on Windows 11 with pnpm 11, 2026-10-24.
    // Removal condition: none while pnpm uses relative links on Windows. Installers have no links.
    this.appDir = join(appRoot, '.work', createHash('sha256').update(work).digest('hex').slice(0, 12))
    this.asar = asar
    this.signingKey = signingKey
    this.trustedKey = trustedKey
    this.logFile = join(work, 'app.log.jsonl')
    this.tree = persist ? new DiskTree(join(work, 'tree')) : new MemoryTree()
    this.userData = join(work, 'user-data')
  }

  static async create(work: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    // Keep the key of an earlier run, so the bundles that the app downloaded before still verify.
    const keyFile = join(work, 'keys.json')
    const keys = existsSync(keyFile)
      ? JSON.parse(readFileSync(keyFile, 'utf8')) as Awaited<ReturnType<typeof createKeyPair>>
      : await createKeyPair()
    mkdirSync(work, { recursive: true })
    writeFileSync(keyFile, `${JSON.stringify(keys, null, 2)}\n`)

    return new Workspace(work, keys.signingKey, keys.trustedKey, options)
  }

  /**
   * Builds the example app with a variant and returns the release of its bundle.
   *
   * The installed build goes into `app/out`, so Electron starts it. Other builds go into `work`, and only their bundle
   * is released.
   */
  async build(releaseId: number, variant: Variant, { installed = false, nativeVersion }: BuildOptions = {}): Promise<BundleRelease> {
    const out = installed ? join(this.appSource, 'out') : join(this.work, 'builds', String(releaseId))
    await buildApp(out, releaseId, variant)

    const release = await bundleReleaseFromBuild({ nativeVersion, outDir: out, signingKey: this.signingKey })
    this.product = release.manifest.product
    if (installed)
      await this.install()

    return release
  }

  /** Writes the canary channel file. `installer` names the newest installer. */
  async point(releaseId: number | undefined, withdrawn: number[] = [], { installer }: { installer?: number } = {}): Promise<void> {
    const current = this.canary()
    // A client ignores a channel file that is not newer than the one it accepted, so keep issue times increasing.
    const issuedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.issuedAt) + 1 : 0)).toISOString()
    const channelFile = await buildChannelFile({
      bundle: releaseId === undefined ? undefined : { releaseId },
      channel: 'canary',
      installer: installer === undefined ? undefined : { releaseId: installer },
      issuedAt,
      product: this.product,
      signingKey: this.signingKey,
      withdrawn,
    })
    this.tree.put(channelFile.files)
  }

  /** Builds a bundle and uploads it. It does not move the channel. */
  async publish(releaseId: number, variant: Variant, options?: BuildOptions): Promise<BundleRelease> {
    const release = await this.build(releaseId, variant, options)
    this.tree.put(uploadStages([release]).flat())

    return release
  }

  /**
   * Publishes an installer release with one file for this platform. The file lives in the tree, at `files/`.
   *
   * `sha512` replaces the hash of the file, to publish a manifest that does not match its file.
   */
  async publishInstaller(releaseId: number, { bytes, feedUrl, sha512 }: { bytes: Uint8Array<ArrayBuffer>, feedUrl: string, sha512?: string }): Promise<InstallerRelease> {
    const key = `files/example-${releaseId}.zip`
    this.tree.put([{ bytes, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/zip' }, immutable: true, key }])
    const release = await buildInstallerRelease({
      artifacts: [{ platform: `${platform}-${arch}`, sha512: sha512 ?? createHash('sha512').update(bytes).digest('base64'), size: bytes.byteLength, url: `${feedUrl}/${key}` }],
      bundleReleaseId: 1,
      host: 'electron',
      nativeVersion: 1,
      product: this.product,
      releaseId,
      signingKey: this.signingKey,
      version: `1.0.${releaseId}`,
    })
    this.tree.put(uploadStages([release]).flat())

    return release
  }

  /** Reads the app events from the log file, in order. */
  readEvents(): LoggedEvent[] {
    if (!existsSync(this.logFile))
      return []

    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as LoggedEvent)
  }

  /** Signs the canary channel file again with the same content. */
  async reissue(): Promise<void> {
    const current = this.canary()
    if (!current)
      throw new Error('The tree has no canary channel file.')

    this.tree.put((await reissueChannelFile(current, this.signingKey)).files)
  }

  /** Removes the installed app from the test package. The work directory stays with the caller. */
  removeApp(): void {
    rmSync(this.appDir, { force: true, maxRetries: 5, recursive: true })
  }

  private canary(): ChannelFile | undefined {
    const file = this.tree.get('channels/canary.json')

    return file && JSON.parse(new TextDecoder().decode(file.bytes)) as ChannelFile
  }

  /**
   * Lays out the installed app: the package manifest and the installed build.
   *
   * With `asar`, the manifest and the build go into `app.asar`. Module resolution walks up from the archive to the
   * dependencies of the test package.
   */
  private async install(): Promise<void> {
    copyFileSync(join(appRoot, 'package.json'), join(this.appSource, 'package.json'))
    if (this.asar) {
      mkdirSync(this.appDir, { recursive: true })
      await createPackage(this.appSource, join(this.appDir, 'app.asar'))
    }
  }
}

/** Returns the first event of a type that matches, with the type of that event. */
export function findEvent<Type extends AppEvent['type']>(
  events: readonly LoggedEvent[],
  type: Type,
  match: (event: Extract<LoggedEvent, { type: Type }>) => boolean = () => true,
): Extract<LoggedEvent, { type: Type }> | undefined {
  return events.find((event): event is Extract<LoggedEvent, { type: Type }> => event.type === type && match(event as Extract<LoggedEvent, { type: Type }>))
}

/** Returns the first status of a kind that matches, with the type of that status. */
export function findStatus<Kind extends UpdaterStatus['status']>(
  events: readonly LoggedEvent[],
  kind: Kind,
  match: (status: Extract<UpdaterStatus, { status: Kind }>) => boolean = () => true,
): Extract<UpdaterStatus, { status: Kind }> | undefined {
  const isMatch = (status: UpdaterStatus): status is Extract<UpdaterStatus, { status: Kind }> => status.status === kind && match(status as Extract<UpdaterStatus, { status: Kind }>)

  return findEvent(events, 'status', event => isMatch(event.status))?.status as Extract<UpdaterStatus, { status: Kind }> | undefined
}

/** Starts the test build of the example app against an update server. Returns a function that stops every app process. */
export async function launchApp(workspace: Workspace, options: LaunchOptions): Promise<() => void> {
  const { applyAll = true, capture, checkMs = 1000, debugPort, e2eInstaller = false, feedUrl, healthMs = 4000, show = false } = options
  const { display, xvfb } = await ensureDisplay()
  const appEnv = {
    ...env,
    ...(display ? { DISPLAY: display } : {}),
    ...(capture ? { ERGOSPHERE_CAPTURE_DIR: capture } : {}),
    ...(show ? { ERGOSPHERE_SHOW_WINDOW: '1' } : {}),
    ...(e2eInstaller ? { ERGOSPHERE_E2E_INSTALLER: '1' } : {}),
    ...(applyAll ? { ERGOSPHERE_E2E_APPLY: '1' } : {}),
    ERGOSPHERE_BOOT_HEALTH_MS: '15000',
    ERGOSPHERE_CHECK_MS: String(checkMs),
    ERGOSPHERE_FEED_URL: feedUrl,
    ERGOSPHERE_HEALTH_MS: String(healthMs),
    ERGOSPHERE_IT_LOG: workspace.logFile,
    ERGOSPHERE_TRUSTED_KEYS: JSON.stringify([workspace.trustedKey]),
    ERGOSPHERE_USER_DATA: workspace.userData,
  }
  const args = [...(platform === 'linux' ? ['--no-sandbox'] : []), ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []), workspace.launchTarget]
  // Stop only the processes of this launch. The event log can hold pids of earlier runs that now belong to others.
  const firstEvent = workspace.readEvents().length
  const child = spawn(electronBinary, args, { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const appLog = join(workspace.work, 'electron.log')
  child.stdout.on('data', data => writeFileSync(appLog, data, { flag: 'a' }))
  child.stderr.on('data', data => writeFileSync(appLog, data, { flag: 'a' }))

  return function stop() {
    for (const pid of new Set([child.pid, ...workspace.readEvents().slice(firstEvent).map(event => event.pid)])) {
      try {
        if (pid !== undefined)
          kill(pid)
      }
      catch {}
    }
    xvfb?.kill()
  }
}

/** Runs `electron-vite build` with the release ID and the build constants of a variant. */
async function buildApp(out: string, releaseId: number, variant: Variant): Promise<void> {
  const variables: Record<string, string> = {
    TEST_ASSET_MB: String(variant.assetMb ?? 0),
    TEST_CRASH: variant.crash ? '1' : '0',
    TEST_MAIN_TAG: variant.mainTag ?? '1',
    TEST_NO_HEALTH: variant.noHealth ? '1' : '0',
    TEST_OUT: out,
    // The installed app is installer release 1, so installer releases of the test are newer.
    UPDATES_INSTALLER_RELEASE_ID: '1',
    UPDATES_RELEASE_ID: String(releaseId),
    UPDATES_VERSION: variant.label,
  }
  // electron.vite.config.ts reads the variant from the environment, as `pnpm build` does.
  const previous = Object.fromEntries(Object.keys(variables).map(name => [name, env[name]]))
  Object.assign(env, variables)
  try {
    await viteBuild({ configFile: join(appRoot, 'electron.vite.config.ts'), logLevel: 'warn', root: appRoot })
  }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined)
        delete env[name]
      else
        env[name] = value
    }
  }
}

// NOTICE:
// xvfb-run stops its X server when its child exits. A relaunch exits the first Electron process, so the relaunched
// process lost its display and hung before boot (found on Debian 13).
// On Linux without a display, start one Xvfb for the whole run instead. Stop it with the app.
async function ensureDisplay(): Promise<{ display?: string, xvfb?: ChildProcess }> {
  if (platform !== 'linux' || env.DISPLAY)
    return { display: env.DISPLAY }

  const display = `:${90 + Math.floor(Math.random() * 400)}`
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
  await delay(1000)

  return { display, xvfb }
}
