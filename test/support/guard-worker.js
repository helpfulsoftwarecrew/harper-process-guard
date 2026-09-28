// @ts-check
// One worker thread doing what every thread of a host does: evaluate the component and call guard().
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

import { guard } from '../../src/index.js';

const { pidDir, binaryPath, args } = workerData;
const result = await guard({
	pidDir,
	spawn,
	version: 1,
	processes: [{ name: 'shared', binaryPath, args }],
});
const state = result.processes[0];
parentPort?.postMessage({ pid: state?.pid, adopted: state?.adopted, started: state?.started });
