// A script of a `?modulePath` import, for a utility process.

import process from 'node:process'

process.parentPort.on('message', () => process.parentPort.postMessage('fork'))
