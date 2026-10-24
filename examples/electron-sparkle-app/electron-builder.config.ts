import type { Configuration } from 'electron-builder'

import { env } from 'node:process'

import { adHocSignAfterPack, sparkleBuilderConfig } from 'electron-sparkle-updater/builder'

// NOTICE:
// sparkleBuilderConfig returns a top-level `zip` key, and the schema of electron-builder 26.18 rejects it.
// The key only turns off the blockmap of the zip, and `mac.target` below makes no blockmap that Sparkle reads.
// Source: electron-sparkle-updater 0.5.3, dist/builder.js.
// Remove the destructure when electron-sparkle-updater stops returning `zip`.
const { zip: _zip, ...sparkle } = sparkleBuilderConfig({
  // The launcher sets the appcast of each installer release, so Sparkle never reads this URL.
  feedUrl: 'https://example.com/unused-appcast.xml',
  // Without a key, the config keeps a placeholder for `electron-sparkle-updater inject-public-key`.
  publicEdKey: env.SPARKLE_ED_PUBLIC_KEY,
})

export default {
  ...sparkle,
  afterPack: adHocSignAfterPack,
  appId: 'it.ergosphere.example.sparkle',
  files: ['out/**', 'package.json', ...sparkle.files],
  mac: { ...sparkle.mac, identity: null, target: ['zip'] },
  productName: 'ErgosphereSparkle',
} satisfies Configuration
