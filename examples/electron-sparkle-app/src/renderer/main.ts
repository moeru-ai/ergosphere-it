import type { UpdaterStatus } from '@ergosphere-it/electron/types'

const element = <Tag extends HTMLElement>(id: string) => document.getElementById(id) as Tag

/** The text of each status. An app translates them. */
function describe(status: UpdaterStatus): string {
  switch (status.status) {
    case 'applying':
      return `Installing ${status.update.version}…`
    case 'checking':
      return 'Checking for updates…'
    case 'disabled':
      return `Updates are off (${status.reason}).`
    case 'download-failed':
      return `${status.update.version} did not download. The app tries again later. (${status.error.code})`
    case 'downloading':
      return `Downloading ${status.update.version}…`
    case 'error':
    case 'verification-failed':
      return `The update check failed. (${status.error.code})`
    case 'idle':
      return ''
    case 'manual-install-required':
      return `${status.update.version} needs a new install. Download it from the website.`
    case 'preparing':
      return `Preparing ${status.update.version}…`
    case 'ready':
      return `${status.update.version} is ready.`
    case 'rolled-back':
      return `The app went back to ${status.to.version} (${status.reason}).`
    case 'up-to-date':
      return 'The app is up to date.'
  }
}

/** The button text for a ready update: a page reload, an app restart, or a new installer. */
const applyText = { install: 'Install and restart', reload: 'Reload', restart: 'Restart' } as const

function render(status: UpdaterStatus): void {
  element('status').textContent = describe(status)

  const progress = element<HTMLProgressElement>('progress')
  progress.hidden = status.status !== 'downloading' && status.status !== 'preparing'
  if (status.status === 'downloading' || status.status === 'preparing')
    progress.value = status.percent

  const apply = element<HTMLButtonElement>('apply')
  apply.hidden = status.status !== 'ready'
  if (status.status === 'ready')
    apply.textContent = applyText[status.update.requires]

  // An installer that keeps failing can be broken itself, so after a few attempts the app offers a download by hand.
  const page = element<HTMLAnchorElement>('download-page')
  const downloadPage = status.status === 'download-failed' && (status.attempts ?? 0) >= 3 ? status.update.downloadPage : undefined
  page.hidden = !downloadPage
  page.href = downloadPage ?? ''
}

element('apply').addEventListener('click', () => void window.updates.apply())
element('check').addEventListener('click', () => void window.updates.check())

async function start(): Promise<void> {
  const { bundle, status } = await window.updates.get()
  element('version').textContent = bundle.version
  element('bundle').textContent = `${bundle.fromInstaller ? 'From the installer' : 'Over the air'} · release ${bundle.releaseId}`
  render(status)
  window.updates.onStatus(render)

  // The page works, so it reports health. A new bundle that never reports it is rolled back.
  window.updates.markHealthy()
}

void start()
