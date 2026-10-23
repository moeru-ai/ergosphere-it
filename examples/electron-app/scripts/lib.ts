// Shared helpers of e2e.ts and demo.ts: an example release workspace and the example app process.

import type { ChildProcess } from 'node:child_process'

import type { UpdateResult } from '@ergosphere-it/driver-electron/core'
import type { HostApiRange, Pointer, SigningKey, TrustedKey } from '@ergosphere-it/protocol'
import type { ComponentSpec, CoreFile, CoreRelease, ShellRelease, TreeFile } from '@ergosphere-it/publish'
import type { Log } from '@guiiai/logg'

import type { ExampleEvent, LoggedEvent } from '../src/events'

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { arch, env, kill, platform } from 'node:process'

import electronPath from 'electron'

import { createPackage } from '@electron/asar'
import { createKeyPair } from '@ergosphere-it/protocol'
import { buildCoreRelease, buildPointer, buildShellRelease, reissuePointer, uploadStages } from '@ergosphere-it/publish'
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

const components: ComponentSpec[] = [
  { dir: 'main', entry: 'main/index.mjs', type: 'electron-main' },
  { dir: 'preload', type: 'electron-preload' },
  { dir: 'renderer', type: 'web' },
]

export interface BuildOptions {
  /** Build into `out` of the example app with the trusted key, so Electron starts it as the installed app. */
  builtin?: boolean
  hostApi?: HostApiRange
  version?: string
}

export interface LaunchOptions {
  applyMode?: 'auto' | 'prompt'
  baseUrl: string
  /** Saves a screenshot after each page loads. */
  capture?: string
  checkMs?: number
  debugPort?: string
  /** Installs shells with the installer of the e2e test, which downloads and quits instead of installing. */
  e2eInstaller?: boolean
  healthMs?: number
  show?: boolean
}

/**
 * One build of the example app. `label` changes the page, and `mainTag` changes the main code. `assetMb` adds a page
 * asset. `crash` and `noMount` build a broken core.
 */
export interface Variant {
  assetMb?: number
  crash?: boolean
  label: string
  mainTag?: string
  noMount?: boolean
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
 * A release workspace: a signing key, an update tree in memory, the builtin core of the example app, and the app event
 * log.
 *
 * `work` is a scratch directory. The installed app lives in `work/app`: the package manifest, the builtin build in
 * `out`, and a link to the `node_modules` of the example. So a demo and an e2e run never share files. With `persist`,
 * the tree is also kept in `work`, so the next run continues from it.
 */
export class Workspace {
  /** The directory of the installed app, as an installer would lay it out. */
  readonly appDir: string
  /** Pack the app into `app.asar`, as installers do, so the builtin core is read from the archive. */
  readonly asar: boolean
  /** The JSON log file of the app. Its entries with `fields.event` are the app events. */
  readonly logFile: string
  readonly signingKey: SigningKey
  readonly tree: MemoryTree
  readonly userData: string
  readonly work: string
  /** What Electron starts: the archive, or the app directory. */
  get launchTarget(): string {
    return this.asar ? join(this.appDir, 'app.asar') : this.appDir
  }

  private readonly trustedKey: TrustedKey

  /** The directory with the package manifest and the builtin build. With `asar`, it is packed into the app directory. */
  private get appSource(): string {
    return this.asar ? join(this.work, 'app-source') : this.appDir
  }

  private constructor(work: string, signingKey: SigningKey, trustedKey: TrustedKey, { asar = false, persist = false }: WorkspaceOptions) {
    this.work = work
    this.appDir = join(work, 'app')
    this.asar = asar
    this.signingKey = signingKey
    this.trustedKey = trustedKey
    this.logFile = join(work, 'app.log.jsonl')
    this.tree = persist ? new DiskTree(join(work, 'tree')) : new MemoryTree()
    this.userData = join(work, 'user-data')
  }

  static async create(work: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    // Keep the key of an earlier run, so the cores that the app downloaded before still verify.
    const keyFile = join(work, 'keys.json')
    const keys = existsSync(keyFile)
      ? JSON.parse(readFileSync(keyFile, 'utf8')) as Awaited<ReturnType<typeof createKeyPair>>
      : await createKeyPair()
    mkdirSync(work, { recursive: true })
    writeFileSync(keyFile, `${JSON.stringify(keys, null, 2)}\n`)

    return new Workspace(work, keys.signingKey, keys.trustedKey, options)
  }

  /**
   * Builds the example app with a variant and returns the release of its core.
   *
   * The builtin build goes into `app/out` with the trusted key, so Electron starts it. Other builds go into `work`,
   * and only their core is released.
   */
  async build(seq: number, variant: Variant, { builtin = false, hostApi = { max: 1, min: 1 }, version = `1.0.0-core.${seq}` }: BuildOptions = {}): Promise<CoreRelease> {
    const out = builtin ? join(this.appSource, 'out') : join(this.work, 'builds', String(seq))
    await buildApp(out, variant, this.trustedKey)

    const files = readCoreFiles(join(out, 'core'))
    const release = await buildCoreRelease({ components, files, host: 'electron', hostApi, product: 'example', seq, signingKey: this.signingKey, version })
    if (builtin) {
      writeFileSync(join(out, 'core.json'), `${JSON.stringify(release.builtin, null, 2)}\n`)
      await this.install()
    }

    return release
  }

  /** Writes the canary realtime pointer. `shell` names the newest shell. */
  async point(seq: number | undefined, revoked: number[] = [], { shell }: { shell?: number } = {}): Promise<void> {
    const current = this.canary()
    // A client ignores a pointer that is not newer than the one it accepted, so keep issue times increasing.
    const issuedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.issuedAt) + 1 : 0)).toISOString()
    const core = seq === undefined ? undefined : { seq }
    const pointer = await buildPointer({ cadence: 'realtime', channel: 'canary', core, issuedAt, product: 'example', revoked, shell: shell === undefined ? undefined : { seq: shell }, signingKey: this.signingKey })
    this.tree.put(pointer.files)
  }

  /** Builds a core and uploads it. It does not move the pointer. */
  async publish(seq: number, variant: Variant, options?: BuildOptions): Promise<CoreRelease> {
    const release = await this.build(seq, variant, options)
    this.tree.put(uploadStages([release]).flat())

    return release
  }

  /**
   * Publishes a shell release with one installer for this platform. The installer lives in the tree, at `installers/`.
   *
   * `sha512` replaces the hash of the installer, to publish a manifest that does not match its file.
   */
  async publishShell(seq: number, { baseUrl, bytes, sha512 }: { baseUrl: string, bytes: Uint8Array<ArrayBuffer>, sha512?: string }): Promise<ShellRelease> {
    const key = `installers/example-${seq}.zip`
    this.tree.put([{ bytes, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/zip' }, immutable: true, key }])
    const release = await buildShellRelease({
      artifacts: [{ platform: `${platform}-${arch}`, sha512: sha512 ?? createHash('sha512').update(bytes).digest('base64'), size: bytes.byteLength, url: `${baseUrl}/${key}` }],
      builtinCoreSeq: 1,
      host: 'electron',
      hostApi: 1,
      product: 'example',
      seq,
      signingKey: this.signingKey,
      version: `1.0.${seq}`,
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
      .map(line => JSON.parse(line) as Log & { fields: { event?: ExampleEvent }, pid: number })
      .flatMap(entry => entry.fields.event ? [{ ...entry.fields.event, pid: entry.pid, time: entry['@timestamp'] }] : [])
  }

  /** Signs the canary pointer again with the same content. */
  async reissue(): Promise<void> {
    const current = this.canary()
    if (!current)
      throw new Error('The tree has no canary pointer.')

    this.tree.put((await reissuePointer(current, this.signingKey)).files)
  }

  private canary(): Pointer | undefined {
    const file = this.tree.get('pointers/canary/realtime.json')

    return file && JSON.parse(new TextDecoder().decode(file.bytes)) as Pointer
  }

  /**
   * Lays out the installed app: the package manifest, the builtin build, and the dependencies.
   *
   * With `asar`, the manifest and the build go into `app.asar`. The dependencies stay outside, and module resolution
   * finds them in the parent directory of the archive.
   */
  private async install(): Promise<void> {
    copyFileSync(join(appRoot, 'package.json'), join(this.appSource, 'package.json'))
    if (this.asar)
      await createPackage(this.appSource, join(this.appDir, 'app.asar'))

    mkdirSync(this.appDir, { recursive: true })
    const modules = join(this.appDir, 'node_modules')
    // A junction needs no rights on Windows. Other platforms ignore the type and create a directory link.
    if (!existsSync(modules))
      symlinkSync(join(appRoot, 'node_modules'), modules, 'junction')
  }
}

/** Returns the result of the first update check with a status that matches, with the type of that result. */
export function findCheck<Status extends UpdateResult['status']>(
  events: readonly LoggedEvent[],
  status: Status,
  match: (result: Extract<UpdateResult, { status: Status }>) => boolean = () => true,
): Extract<UpdateResult, { status: Status }> | undefined {
  const isMatch = (result: UpdateResult): result is Extract<UpdateResult, { status: Status }> => result.status === status && match(result as Extract<UpdateResult, { status: Status }>)

  return findEvent(events, 'check', event => isMatch(event.result))?.result as Extract<UpdateResult, { status: Status }> | undefined
}

/** Returns the first event of a type that matches, with the type of that event. */
export function findEvent<Type extends ExampleEvent['type']>(
  events: readonly LoggedEvent[],
  type: Type,
  match: (event: Extract<LoggedEvent, { type: Type }>) => boolean = () => true,
): Extract<LoggedEvent, { type: Type }> | undefined {
  return events.find((event): event is Extract<LoggedEvent, { type: Type }> => event.type === type && match(event as Extract<LoggedEvent, { type: Type }>))
}

/** Starts the example app against an update server. Returns a function that stops every app process. */
export async function launchApp(workspace: Workspace, options: LaunchOptions): Promise<() => void> {
  const { applyMode = 'auto', baseUrl, capture, checkMs = 1000, debugPort, e2eInstaller = false, healthMs = 4000, show = false } = options
  const { display, xvfb } = await ensureDisplay()
  const appEnv = {
    ...env,
    ...(display ? { DISPLAY: display } : {}),
    ...(capture ? { ERGOSPHERE_CAPTURE_DIR: capture } : {}),
    ...(show ? { ERGOSPHERE_SHOW_WINDOW: '1' } : {}),
    ...(e2eInstaller ? { ERGOSPHERE_E2E_INSTALLER: '1' } : {}),
    ERGOSPHERE_APPLY_MODE: applyMode,
    ERGOSPHERE_BASE_URL: baseUrl,
    ERGOSPHERE_BOOT_HEALTH_MS: '15000',
    ERGOSPHERE_CHECK_MS: String(checkMs),
    ERGOSPHERE_HEALTH_MS: String(healthMs),
    ERGOSPHERE_LOG_FILE: workspace.logFile,
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

/** Runs `electron-vite build` with the build constants of a variant. */
async function buildApp(out: string, variant: Variant, trustedKey: TrustedKey): Promise<void> {
  const variables: Record<string, string> = {
    EXAMPLE_ASSET_MB: String(variant.assetMb ?? 0),
    EXAMPLE_CRASH: variant.crash ? '1' : '0',
    EXAMPLE_LABEL: variant.label,
    EXAMPLE_MAIN_TAG: variant.mainTag ?? '1',
    EXAMPLE_NO_MOUNT: variant.noMount ? '1' : '0',
    EXAMPLE_OUT: out,
    EXAMPLE_TRUSTED_KEY: JSON.stringify(trustedKey),
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

/** Reads every file of a core directory into memory, with `/` separators in paths. */
function readCoreFiles(dir: string): CoreFile[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)

      return { bytes: new Uint8Array(readFileSync(path)), path: relative(dir, path).split(sep).join('/') }
    })
}
