// A second main entry, for a utility process. Main finds it next to itself in the bundle.

import process from 'node:process'

process.parentPort.on('message', () => process.parentPort.postMessage('sync'))
