// A worker of a `?nodeWorker` import.

import { parentPort } from 'node:worker_threads'

parentPort?.postMessage('worker')
