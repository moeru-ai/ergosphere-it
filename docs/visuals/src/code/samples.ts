// The code tour: the files you touch to set up ergosphere-it, as the README shows them.
// Each note points at lines of its file, counted from 1.

export interface Sample {
  code: string
  file: string
  key: string
  lang: 'bash' | 'ts'
  notes: Note[]
}

interface Note {
  lines: number[]
  text: string
}

export const SAMPLES: Sample[] = [
  {
    code: `import { defineConfig } from '@ergosphere-it/electron/config'

export default defineConfig({
  channel: 'stable',
  feedUrl: 'https://updates.example.com',
  nativeVersion: 1,
  publicKeys: ['ssh-ed25519 <your public key>'],
})`,
    file: 'ergo.config.ts',
    key: 'config',
    lang: 'ts',
    notes: [
      { lines: [4], text: 'The channel this build follows. The app can switch it at run time.' },
      { lines: [5], text: 'Where the app reads updates. Any static host over HTTPS works.' },
      { lines: [6], text: 'Raise it when you upgrade Electron or a native module. Those changes need a full install.' },
      { lines: [7], text: 'Only bundles signed by these keys run. ergosphere-it keygen makes the pair.' },
    ],
  },
  {
    code: `import ergosphereMain from '@ergosphere-it/electron/vite/main'
import ergospherePreload from '@ergosphere-it/electron/vite/preload'
import ergosphereRenderer from '@ergosphere-it/electron/vite/renderer'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { plugins: [ergosphereMain()] },
  preload: { plugins: [ergospherePreload()] },
  renderer: { plugins: [vue(), ergosphereRenderer()] },
})`,
    file: 'electron.vite.config.ts',
    key: 'build',
    lang: 'ts',
    notes: [
      { lines: [8], text: 'Builds the launcher and the main code of the bundle. Point main in package.json at out/launcher/index.mjs.' },
      { lines: [9], text: 'Builds the preload script as CommonJS, so it works in a sandbox.' },
      { lines: [10], text: 'Builds the pages, then writes bundle.json with every file and its hash.' },
    ],
  },
  {
    code: `import { activeBundle, updater } from '@ergosphere-it/electron/main'
import { app, BrowserWindow, ipcMain } from 'electron'

app.whenReady().then(() => {
  const window = new BrowserWindow({
    webPreferences: { preload: activeBundle.preload, sandbox: true },
  })
  void window.loadURL(activeBundle.pageUrl())
})

ipcMain.on('app:ready', () => updater.markBundleHealthy())
ipcMain.handle('update:apply', () => updater.applyUpdate())`,
    file: 'src/main/index.ts',
    key: 'main',
    lang: 'ts',
    notes: [
      { lines: [6], text: 'The preload script of the bundle that runs now, not of the one you built with.' },
      { lines: [8], text: 'Pages load from the active bundle. After a page-only update, windows reload on the same routes.' },
      { lines: [11], text: 'Tell the launcher that this bundle works. A bundle that never says so goes back.' },
      { lines: [12], text: 'Apply a ready update when the user agrees: a reload, a restart, or an install.' },
    ],
  },
  {
    code: `# Send a bundle to 20% of the beta channel
pnpm build
pnpm exec ergosphere-it publish bundle --channel beta --rollout 20

# Raise it later. Installs keep their buckets.
pnpm exec ergosphere-it rollout --channel beta 50

# Pull a bad one. Apps go back at their next check.
pnpm exec ergosphere-it withdraw 1761320000000`,
    file: 'ci',
    key: 'publish',
    lang: 'bash',
    notes: [
      { lines: [3], text: 'Signs with ERGOSPHERE_IT_SIGNING_KEY and uploads to ERGOSPHERE_IT_BUCKET: the files, then the manifest, then the channel.' },
      { lines: [6], text: 'More installs get it. The ones that had it keep it.' },
      { lines: [9], text: 'Every app that runs it goes back to the bundle before it, and says why.' },
    ],
  },
]
