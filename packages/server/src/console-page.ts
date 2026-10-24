/** The release console. One static page that talks to /_api. */
export const consolePage = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ergosphere-it console</title>
<style>
  :root { --bg: #f6f6f4; --panel: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e3de; --accent: #4b45c2; --ok: #1f8a4c; --bad: #c0362c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --panel: #1f1f1d; --text: #ecece8; --muted: #9a9a94; --line: #34342f; --accent: #8f89ff; --ok: #4cc27f; --bad: #ff7a6e; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0; }
  #app { color: var(--muted); }
  .publish { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
  input, select { font: inherit; padding: 7px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--text); }
  input { width: 120px; }
  button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 7px; padding: 6px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; padding: 8px 18px; }
  button:disabled { opacity: .5; cursor: progress; }
  #error { color: var(--bad); min-height: 20px; margin: 8px 2px; font-size: 13px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 18px 0 8px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  td { padding: 9px 12px; border-top: 1px solid var(--line); white-space: nowrap; }
  tr:first-child td { border-top: 0; }
  td.version { font-weight: 600; }
  td.muted { color: var(--muted); }
  td.actions { text-align: right; }
  td.actions button { margin-left: 6px; }
  .desync { border: 1px solid var(--bad); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
  .desync button { margin-top: 8px; }
  .serving { color: var(--ok); } .failed, .withdrawn { color: var(--bad); } .running { color: var(--accent); }
</style>
</head>
<body>
<main>
  <header><h1>ergosphere-it console</h1><span id="app">Waiting for the app…</span></header>

  <div class="publish">
    <label>Version<input id="version"></label>
    <label>Change<select id="change"></select></label>
    <label>Channel<select id="channel"></select></label>
    <label>Rollout<select id="rollout"><option value="100">100%</option><option value="50">50%</option><option value="10">10%</option><option value="0">0%</option></select></label>
    <button class="primary" id="publish">Publish</button>
  </div>
  <div id="error"></div>
  <div id="desync" class="desync" hidden></div>

  <h2>History</h2>
  <table><tbody id="history"><tr><td class="muted">No releases yet.</td></tr></tbody></table>
</main>
<script>
const $ = id => document.getElementById(id)
const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
let state

async function post(name, body) {
  $('error').textContent = ''
  const response = await fetch('/_api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) $('error').textContent = (await response.json()).error
  return response.ok
}

function statusOf(entry) {
  const client = state.clientState ?? {}
  const file = state.channelFiles.find(f => f.channel === entry.channel)
  const labels = []
  if (client.running === entry.releaseId) labels.push('<span class="running">● On the app</span>')
  if (file?.withdrawn?.includes(entry.releaseId)) labels.push('<span class="withdrawn">Withdrawn</span>')
  else if (client.blocked?.includes(entry.releaseId)) labels.push('<span class="failed">✕ Failed on the app</span>')
  if (file?.bundle?.releaseId === entry.releaseId) labels.push('<span class="serving">Serving' + (file.bundle.rollout ? ' to ' + file.bundle.rollout.percentage + '%' : '') + '</span>')

  return labels.join(' · ')
}

function isWithdrawn(entry) {
  return state.channelFiles.some(f => f.channel === entry.channel && f.withdrawn?.includes(entry.releaseId))
}

// The form keeps what the user chose. A render rebuilds the options only when the list changes, because replacing an
// open select closes it. The version follows the suggestion only while the user has not edited it.
let optionsKey
let suggested
function renderForm() {
  const key = JSON.stringify([state.changes, state.channels])
  if (key !== optionsKey) {
    optionsKey = key
    const change = $('change').value, channel = $('channel').value
    $('change').innerHTML = state.changes.map(c => '<option value="' + escape(c.id) + '"' + (c.id === change ? ' selected' : '') + '>' + escape(c.label) + '</option>').join('')
    $('channel').innerHTML = state.channels.map(c => '<option' + (c === channel ? ' selected' : '') + '>' + escape(c) + '</option>').join('')
  }
  const version = $('version')
  if (document.activeElement !== version && (version.value === '' || version.value === suggested))
    version.value = state.nextVersion
  suggested = state.nextVersion
}

function render() {
  renderForm()

  const labelOf = id => state.changes.find(c => c.id === id)?.label ?? id
  const client = state.clientState
  const unknown = client?.running !== undefined && !state.history.some(entry => entry.releaseId === client.running)
    ? '<tr><td class="version">' + escape(client.runningVersion ?? 'release ' + client.running) + '</td><td class="muted" colspan="3">Not in the history of this server</td><td><span class="running">● On the app</span></td>'
      + '<td class="actions"><button data-withdraw="' + Number(client.running) + '">Withdraw</button></td></tr>'
    : ''
  renderDesync(client)
  const rows = [unknown].concat(state.history.slice().reverse().map(entry => '<tr>'
    + '<td class="version">' + escape(entry.version) + '</td>'
    + '<td>' + escape(labelOf(entry.change)) + '</td>'
    + '<td class="muted">' + escape(entry.channel) + (entry.rollout < 100 ? ' ' + Number(entry.rollout) + '%' : '') + '</td>'
    + '<td class="muted">' + new Date(entry.publishedAt).toLocaleTimeString([], { hour12: false }) + '</td>'
    + '<td>' + statusOf(entry) + '</td>'
    + '<td class="actions">' + (isWithdrawn(entry) ? '' : '<button data-withdraw="' + Number(entry.releaseId) + '" title="The channel goes back to its newest earlier release, and the app leaves this one.">Withdraw</button>') + '</td>'
    + '</tr>'))
  $('history').innerHTML = rows.join('') || '<tr><td class="muted">No releases yet.</td></tr>'

  const running = state.history.find(entry => entry.releaseId === client?.running)
  $('app').textContent = client ? 'App runs ' + (running?.version ?? client.runningVersion ?? 'release ' + client.running) + (client.pid ? ' · pid ' + client.pid : '') : 'Waiting for the app…'
}

function renderDesync(client) {
  const check = client?.lastCheck
  const unknown = client?.running !== undefined && !state.history.some(entry => entry.releaseId === client.running)
  const replayed = check?.status === 'verification-failed' && check.code === 'channel-replayed'
  let message = ''
  if (replayed)
    message = 'The app ignores the channel files of this server, because they are older than channel files the app accepted. Publish a new version, or sign the channel files again.'
  else if (unknown)
    message = 'The app runs ' + (client.runningVersion ?? 'release ' + client.running) + ', which this server does not know. The app never goes back. Publish a newer version, and the app takes it.'
  else if (check?.status === 'up-to-date' && check.detail === 'app-newer-than-feed')
    message = 'The app runs a newer release than this server serves. The app never goes back. Publish a new version, and the app takes it.'
  $('desync').hidden = !message
  $('desync').innerHTML = message ? escape(message) + (replayed ? '<br><button id="reissue">Sign channel files again</button>' : '') : ''
}

$('desync').addEventListener('click', (event) => {
  if (event.target.id === 'reissue') post('reissue', {})
})

$('publish').addEventListener('click', async () => {
  $('publish').disabled = true
  try {
    // After a publish, the version field takes the next suggestion again.
    if (await post('publish', { change: $('change').value, channel: $('channel').value, rollout: Number($('rollout').value), version: $('version').value }))
      $('version').value = ''
  }
  finally { $('publish').disabled = false; $('version').blur(); render() }
})
$('history').addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (button?.dataset.withdraw) post('withdraw', { releaseId: Number(button.dataset.withdraw) })
})

fetch('/_api/state').then(r => r.json()).then((next) => { state = next; render() })
const events = new EventSource('/_api/events')
events.addEventListener('state', (e) => { state = JSON.parse(e.data); render() })
events.addEventListener('client-state', (e) => { if (state) { state.clientState = JSON.parse(e.data); render() } })
</script>
</body>
</html>
`
