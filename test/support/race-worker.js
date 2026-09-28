// @ts-check
// One contender in the lock race. Blocks on the round counter, claims, and reports whether it won.
// Real worker threads, because the interleaving is the whole subject and a scheduler cannot be faked.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';

import { claimLock, commitLock, lockPath } from '../../src/lock.js';
import { slow } from './harness.js';

const { control, baseDir, name, version } = workerData;
const ROUND = 0;
const WINNERS = 1;
const FINISHED = 2;
const STOP = 3;

// The interpreter alone, which is a leading run of this live process's real command line on every
// platform: what argvOf() reads back is one joined string, and win32 re-quotes that into a mismatch.
const argv = [process.execPath];

async function main() {
	const ctl = new Int32Array(control);
	let seen = 0;
	for (;;) {
		Atomics.wait(ctl, ROUND, seen);
		seen = Atomics.load(ctl, ROUND);
		if (Atomics.load(ctl, STOP) === 1) break;

		// join(), because the runner seeds this same directory and Windows separates path segments the other way.
		const pidDir = join(baseDir, `round-${seen}`);
		const claim = await claimLock({ pidDir, name, version, argv, timeoutMs: slow(5000) });
		// Every outcome recorded, not just the wins: a round with two winners has to name both.
		appendFileSync(join(pidDir, 'claims.log'), JSON.stringify({ thread: threadId, ...claim }) + '\n');
		if (claim.outcome === 'won') {
			// Committed at once, exactly as the supervisor does: until a claim names a live process,
			// every other thread is still waiting on it rather than deciding anything.
			await commitLock(lockPath(pidDir, name), claim.token, process.pid, version, argv);
			Atomics.add(ctl, WINNERS, 1);
		}
		Atomics.add(ctl, FINISHED, 1);
		Atomics.notify(ctl, FINISHED);
	}
	parentPort?.postMessage('done');
}

main().catch((error) => {
	parentPort?.postMessage(`error: ${error?.message ?? error}`);
});
