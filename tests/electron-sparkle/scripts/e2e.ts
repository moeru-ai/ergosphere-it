// End-to-end test of Sparkle as the installer, on macOS: a packaged 1.0.0 installs 1.1.0 through a Sparkle delta.
//
// It builds and packages both versions of the Sparkle example, registers 1.1.0 with an appcast, starts 1.0.0, and
// presses Install through the DevTools protocol when the page shows the update. Then it checks:
//   - the app on disk is 1.1.0, and passes codesign --verify
//   - Sparkle downloaded a delta, and not the archive
//
// Usage: node scripts/e2e.ts [--dir <dir>] [--port 4200]
//
// --dir holds the keys, the builds, the served files, and the installed app. Each run empties it. Keep it outside the
// repository. The default is a new temporary directory.

import { spawn } from 'node:child_process'
import { argv, exit, platform } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { codesignPasses, prepareReleases, pressInstall, versionOnDisk, versions } from './lib.ts'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
    dir: { type: 'string' },
    port: { default: '4200', type: 'string' },
  },
})

if (platform !== 'darwin') {
  console.error('Sparkle runs only on macOS.')
  exit(1)
}

const port = Number(options.port)
const latest = versions[1]
const { app, executable, served, server } = await prepareReleases({ port, work: options.dir })
const debugPort = port + 1
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], { stdio: 'ignore' })

let ok = false
try {
  const clicked = await pressInstall(debugPort)
  // Sparkle quits the app, replaces it, and opens it again.
  for (let attempt = 0; attempt < 60 && versionOnDisk(app) !== latest; attempt++)
    await delay(1000)

  const downloads = served.filter(path => path.startsWith('/sparkle/'))
  const checks = {
    [`the app on disk is ${latest}`]: versionOnDisk(app) === latest,
    'Install was pressed': clicked,
    'Sparkle did not download an archive': !downloads.some(path => path.endsWith('.zip')),
    'Sparkle downloaded a delta': downloads.some(path => path.endsWith('.delta')),
    'the app passes codesign --verify': codesignPasses(app),
  }
  for (const [name, passed] of Object.entries(checks))
    console.info(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  ok = Object.values(checks).every(Boolean)
}
finally {
  child.kill()
  // Sparkle opened a new process of the app, which is not a child of this script.
  spawn('pkill', ['-f', executable], { stdio: 'ignore' })
  server.close()
}

exit(ok ? 0 : 1)
