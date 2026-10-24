import type { NativeVersionRange, SigningKey } from '@ergosphere-it/protocol'
import type { BundleRelease, ComponentSpec, InstallerFileInput, InstallerRelease } from '@ergosphere-it/publish'

import type { BuildInfo } from './layout'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildBundleRelease, buildInstallerRelease } from '@ergosphere-it/publish'

import { OUT_LAYOUT } from './layout'

export type { BuildInfo } from './layout'

export interface BundleReleaseFromBuildOptions {
  /** Native versions that can run the bundle. Defaults to the native version of the build only. */
  nativeVersion?: NativeVersionRange
  /** The output directory of the ergosphere-it plugins. Defaults to `out`. */
  outDir?: string
  signingKey: SigningKey
}

export interface InstallerReleaseFromBuildOptions {
  /** One installer file per platform, for example from the `latest*.yml` files of electron-builder. */
  artifacts: InstallerFileInput[]
  /** The output directory of the ergosphere-it plugins. Defaults to `out`. */
  outDir?: string
  signingKey: SigningKey
}

/** Builds a signed bundle release from the output of the ergosphere-it plugins: the files of `out/bundle/` and `out/bundle.json`. */
export async function bundleReleaseFromBuild({ nativeVersion, outDir = 'out', signingKey }: BundleReleaseFromBuildOptions): Promise<BundleRelease> {
  const info = readBuildInfo(outDir)
  const bundleDir = join(outDir, OUT_LAYOUT.bundle)
  const components: ComponentSpec[] = info.components.map(component => ({ dir: component.files[0]!.path.split('/')[0]!, entry: component.entry, type: component.type }))
  const files = info.components.flatMap(component => component.files.map(file => ({
    bytes: new Uint8Array(readFileSync(join(bundleDir, ...file.path.split('/')))) as Uint8Array<ArrayBuffer>,
    path: file.path,
  })))

  return buildBundleRelease({
    components,
    files,
    host: 'electron',
    nativeVersion: nativeVersion ?? { max: info.nativeVersion, min: info.nativeVersion },
    product: info.product,
    releaseId: info.releaseId,
    signingKey,
    version: info.version,
  })
}

/** Builds a signed installer release for the installers that electron-builder made from the output of the ergosphere-it plugins. */
export async function installerReleaseFromBuild({ artifacts, outDir = 'out', signingKey }: InstallerReleaseFromBuildOptions): Promise<InstallerRelease> {
  const info = readBuildInfo(outDir)

  return buildInstallerRelease({
    artifacts,
    bundleReleaseId: info.releaseId,
    host: 'electron',
    nativeVersion: info.nativeVersion,
    product: info.product,
    releaseId: info.installerReleaseId,
    signingKey,
    version: info.version,
  })
}

/** Reads `out/bundle.json`, which the ergosphere-it plugins write at build time. */
export function readBuildInfo(outDir = 'out'): BuildInfo {
  return JSON.parse(readFileSync(join(outDir, OUT_LAYOUT.buildInfo), 'utf8')) as BuildInfo
}
