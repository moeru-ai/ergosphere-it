// Demo of Sparkle as the installer, on macOS. It builds and packages both versions of the Sparkle example, registers
// 1.1.0 with an appcast, serves the files, and starts 1.0.0. When the page shows that 1.1.0 is ready, press Install and
// restart: Sparkle downloads the delta and opens the app again as 1.1.0. Press Ctrl+C to stop.
//
// Usage: node scripts/demo.ts [--dir <dir>] [--port 4200] [--no-launch]

import { spawn } from 'node:child_process'
import { argv, exit, platform } from 'node:process'
import { parseArgs } from 'node:util'

import { prepareReleases, versions } from './lib.ts'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
    'dir': { type: 'string' },
    'no-launch': { default: false, type: 'boolean' },
    'port': { default: '4200', type: 'string' },
  },
})

if (platform !== 'darwin') {
  console.error('Sparkle runs only on macOS.')
  exit(1)
}

const { app, executable } = await prepareReleases({ port: Number(options.port), work: options.dir })
if (options['no-launch']) {
  console.info(`Start it with: open "${app}"`)
}
else {
  spawn(executable, [], { detached: true, stdio: 'ignore' }).unref()
  console.info(`Press Install and restart in the app. Sparkle downloads the delta and opens the app again as ${versions[1]}.`)
}
