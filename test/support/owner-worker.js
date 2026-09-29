// @ts-check
// A thread that starts the process and is then ended by the test, the way a host ends a worker thread it replaces.
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

import { guard } from '../../src/index.js';
import { superviseProcess } from '../../src/supervise.js';
import { context, waitFor } from './harness.js';

/** @type {{ pidDir: string, name: string, argv: string[], viaGuard: boolean, stdio?: import('node:child_process').StdioOptions }} */
const { pidDir, name, argv, viaGuard, stdio = 'ignore' } = workerData;
const [binaryPath = '', ...args] = argv;
let read = 0;
/** @type {import('../../src/supervise.js').Spawn} */
const reading = (command, spawnArgs, options) => {
	const child = spawn(command, spawnArgs, options);
	// Read the way a host that logs its processes' output would.
	for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => (read += chunk.length));
	return child;
};
const state = viaGuard
	? (await guard({ pidDir, spawn, version: 1, processes: [{ name, binaryPath, args }] })).processes[0]
	: await superviseProcess(context(pidDir, reading, { keeper: true }), {
			name,
			title: name,
			binaryPath,
			args,
			argv,
			spawnOptions: { stdio },
		});
if (stdio !== 'ignore' && state?.started) await waitFor(() => read > 0, "the process's output to reach this thread");
// The listener holds this thread open until the test terminates it.
parentPort?.on('message', () => {});
parentPort?.postMessage({
	pid: state?.pid,
	started: state?.started,
	adopted: state?.adopted,
	error: state?.error,
	read,
});
