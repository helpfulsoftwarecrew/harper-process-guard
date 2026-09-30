// @ts-check
// A thread that launches the reaper and is then ended by the test, the way a host ends a worker thread it replaces.
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

import { guard } from '../../src/index.js';

/** @type {{ pidDir: string, name: string }} */
const { pidDir, name } = workerData;
// A grace long past the test, so the reaper watches and does nothing else while it runs.
const { reaper } = await guard({ pidDir, spawn, version: 1, processes: [], reaper: { name, graceMs: 600_000 } });
// The listener holds this thread open until the test terminates it.
parentPort?.on('message', () => {});
parentPort?.postMessage({ pid: reaper?.pid, started: reaper?.started, error: reaper?.error });
