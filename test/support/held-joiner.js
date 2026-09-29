// @ts-check
// A thread that joins a kept process, and whose read of the restart it waits on returns only once that restart was
// stopped and its keeper had exited, as a thread descheduled right after the read would see it.
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

import { isAlive } from '../../src/identity.js';
import { superviseProcess } from '../../src/supervise.js';
import { context } from './harness.js';

/** @type {{ pidDir: string, lock: string, marker: string, descriptor: import('../../src/supervise.js').Descriptor }} */
const { pidDir, lock, marker, descriptor } = workerData;
const fs = createRequire(import.meta.url)('node:fs');
const readFileSync = fs.readFileSync;
const record = `${lock}.exit`;
let held = false;

/** @param {number} keeper */
function finished(keeper) {
	try {
		return JSON.parse(readFileSync(record, 'utf-8')).outcome !== 'restarting' && !isAlive(keeper);
	} catch {
		return true;
	}
}

fs.readFileSync = (/** @type {string} */ file, /** @type {unknown} */ options) => {
	const content = readFileSync(file, options);
	if (held || file !== record) return content;
	const read = JSON.parse(String(content));
	// Only once the restart is due, which is the wait for it; the first answer to the death comes well before that.
	if (read.outcome !== 'restarting' || Date.now() < read.at + read.waitMs / 2) return content;
	held = true;
	fs.writeFileSync(marker, '');
	// Longer than the thread waits between looks at its keeper, so a look is due as soon as this returns.
	const earliest = Date.now() + 400;
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && (Date.now() < earliest || !finished(read.keeper)))
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	return content;
};
syncBuiltinESMExports();

const ctx = context(pidDir, spawn, { keeper: true });
const state = await superviseProcess(ctx, descriptor);
parentPort?.on('message', () => parentPort?.postMessage(ctx.log.all()));
parentPort?.postMessage({ adopted: state.adopted, error: state.error });
