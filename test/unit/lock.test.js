// @ts-check
// The lock is the whole point of the package: everything else assumes exactly one thread got through.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { aliveBudgetMs, argvOf, identifyBudgetMs, isAlive } from '../../src/identity.js';
import {
	CLAIM_TIMEOUT_MS,
	claimLock,
	claimTimeoutMs,
	commitLock,
	gateWaitMs,
	keeperBootMs,
	lockPath,
	readLock,
	releaseLock,
	safeLockWrite,
	START_FAILURE_MS,
} from '../../src/lock.js';
import {
	deadPid,
	fixture,
	pidOf,
	readyLine,
	seedLock,
	settle,
	skipOnWindows,
	slow,
	waitFor,
	WINDOWS,
	withSpawn,
	withTempDir,
} from '../support/harness.js';

const THREADS = 8;
// Every loser identifies the winner's pid, which on Windows is a PowerShell start, so fewer rounds run
// there; the test name reports whichever count ran.
const ROUNDS = WINDOWS ? 60 : 300;
const ROUND = 0;
const WINNERS = 1;
const FINISHED = 2;
const STOP = 3;

/** @param {Int32Array} ctl @param {number} index @param {number} want */
async function reach(ctl, index, want) {
	for (;;) {
		const seen = Atomics.load(ctl, index);
		if (seen >= want) return;
		const waited = Atomics.waitAsync(ctl, index, seen, slow(10_000));
		if (waited.async) await waited.value;
		else if (waited.value === 'timed-out') throw new Error(`only ${seen} of ${want} threads reported in`);
	}
}

test(
	`${ROUNDS} races of ${THREADS} worker threads over a stale lock produce exactly one winner each`,
	// Windows does far more filesystem work per gate than either POSIX host, so the ceiling moves with it.
	{ timeout: slow(120_000) },
	async () => {
		// Move publish() out of underGate, or make takeGate always return true, and only this test fails.
		const gone = await deadPid();
		return withTempDir('guard-race-', async (dir) => {
			const control = new SharedArrayBuffer(16);
			const ctl = new Int32Array(control);
			const workers = Array.from(
				{ length: THREADS },
				() =>
					new Worker(path.join(import.meta.dirname, '..', 'support', 'race-worker.js'), {
						workerData: { control, baseDir: dir, name: 'raced', version: 7 },
					})
			);
			/** @type {string[]} */
			const failures = [];
			for (const worker of workers)
				worker.on('message', (m) => typeof m === 'string' && m !== 'done' && failures.push(m));

			try {
				for (let round = 1; round <= ROUNDS; round++) {
					const pidDir = path.join(dir, `round-${round}`);
					// Seeded stale, because an absent lock never reaches the reclaim path, where two winners come from.
					seedLock(lockPath(pidDir, 'raced'), { pid: gone, version: 7, argv: ['/previous/boot'] });

					Atomics.store(ctl, WINNERS, 0);
					Atomics.store(ctl, FINISHED, 0);
					Atomics.store(ctl, ROUND, round);
					Atomics.notify(ctl, ROUND);
					await reach(ctl, FINISHED, THREADS);

					assert.equal(
						Atomics.load(ctl, WINNERS),
						1,
						`round ${round} had more than one winner:\n${fs.readFileSync(path.join(pidDir, 'claims.log'), 'utf-8')}`
					);
					const held = readLock(lockPath(pidDir, 'raced'));
					assert.equal(held?.pid, process.pid, `round ${round} left a lock naming something else`);
				}
			} finally {
				Atomics.store(ctl, STOP, 1);
				Atomics.add(ctl, ROUND, 1);
				Atomics.notify(ctl, ROUND);
				await Promise.all(workers.map((worker) => worker.terminate()));
			}
			assert.deepEqual(failures, []);
		});
	}
);

test('the lock is pid on line 1 and version on line 2, so a host reading only those two agrees', () =>
	withTempDir('guard-lock-', async (dir) => {
		const claim = await claimLock({ pidDir: dir, name: 'shape', version: 4242, argv: ['/bin/thing', '--flag'] });
		assert.equal(claim.outcome, 'won');
		if (claim.outcome !== 'won') return;
		await commitLock(lockPath(dir, 'shape'), claim.token, 9911, 4242, ['/bin/thing', '--flag']);

		const lines = fs.readFileSync(lockPath(dir, 'shape'), 'utf-8').split('\n');
		assert.equal(lines[0], '9911');
		assert.equal(lines[1], '4242');
		assert.deepEqual(JSON.parse(lines[2] ?? '').argv, ['/bin/thing', '--flag']);
	}));

test('a claim that has not named a process yet reads pid 0, so nothing adopts a claim as a process', () =>
	withTempDir('guard-lock-', async (dir) => {
		const claim = await claimLock({ pidDir: dir, name: 'pending', version: 1, argv: ['/bin/thing'] });
		assert.equal(claim.outcome, 'won');
		assert.equal(readLock(lockPath(dir, 'pending'))?.pid, 0);
	}));

test('a stale lock from a dead pid is reclaimed', () =>
	withTempDir('guard-lock-', async (dir) => {
		const gone = await deadPid();
		seedLock(lockPath(dir, 'stale'), { pid: gone, version: 1, argv: ['/bin/thing'] });

		const claim = await claimLock({ pidDir: dir, name: 'stale', version: 1, argv: ['/bin/thing'] });
		assert.equal(claim.outcome, 'won');
		assert.match(claim.notes.join('\n'), new RegExp(`reclaimed the lock from pid ${gone}`));
	}));

test('a lock naming a live process with this configuration is joined, not taken', () =>
	withTempDir('guard-lock-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), 'joinable'];
			const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
			seedLock(lockPath(dir, 'live'), { pid: pidOf(child), version: 3, argv });

			const claim = await claimLock({ pidDir: dir, name: 'live', version: 3, argv });
			assert.equal(claim.outcome, 'adopted');
			if (claim.outcome !== 'adopted') return;
			assert.equal(claim.pid, pidOf(child));
			// The lock is untouched: whoever holds it still holds it.
			assert.equal(readLock(lockPath(dir, 'live'))?.token, 'seeded');
		})
	));

test('a lock naming a live process running something else is taken, and that process is not signalled', () =>
	withTempDir('guard-lock-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			const child = spawn(process.execPath, [fixture('idle.js'), 'a-stranger'], { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
			// The pid was reused by something this node never started, which is routine in a container.
			seedLock(lockPath(dir, 'foreign'), { pid: pidOf(child), version: 1, argv: [process.execPath, '/gone.js'] });

			const claim = await claimLock({ pidDir: dir, name: 'foreign', version: 1, argv: [process.execPath, '/ours.js'] });
			assert.equal(claim.outcome, 'won');
			assert.match(claim.notes.join('\n'), /is running something else/);
			assert.equal(child.killed, false);
			assert.notEqual(argvOf(pidOf(child)), null, 'the stranger was signalled');
		})
	));

test('a live pid no verdict could be reached on is waited on, because unknown is not "runs something else"', () =>
	withTempDir('guard-lock-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), 'unverdicted'];
			const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
			// A live pid whose command line cannot be read, which is what a probe that ran out of time leaves.
			seedLock(lockPath(dir, 'unverdicted'), { pid: pidOf(child), version: 1, argv: [] });

			let settled = false;
			const claim = claimLock({ pidDir: dir, name: 'unverdicted', version: 1, argv, timeoutMs: slow(5000) }).then(
				(result) => {
					settled = true;
					return result;
				}
			);
			await settle(100);
			assert.equal(settled, false, "a pid that could not be identified was ruled somebody else's");

			// The verdict lands, and the waiter joins the process rather than starting a second one.
			seedLock(lockPath(dir, 'unverdicted'), { pid: pidOf(child), version: 1, argv });
			assert.deepEqual(await claim, {
				outcome: 'adopted',
				pid: pidOf(child),
				notes: [`unverdicted: joined the running pid ${pidOf(child)} rather than starting a second one.`],
			});
		})
	));

test('a verdict that never arrives outlives the budget and the lock is taken, so an unreadable pid cannot wedge a start', () =>
	withTempDir('guard-lock-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), 'never-verdicted'];
			const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
			seedLock(lockPath(dir, 'unreadable'), { pid: pidOf(child), version: 1, argv: [] });

			const claim = await claimLock({ pidDir: dir, name: 'unreadable', version: 1, argv, timeoutMs: slow(50) });
			assert.equal(claim.outcome, 'won');
			assert.match(claim.notes.join('\n'), /could not be identified inside the claim budget/);
		})
	));

test('a live process under a different version is an orphan, reported and left alone while stopOrphans is off', () =>
	withTempDir('guard-lock-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), 'old-release'];
			const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
			seedLock(lockPath(dir, 'upgrade'), { pid: pidOf(child), version: 100, argv });

			const claim = await claimLock({ pidDir: dir, name: 'upgrade', version: 200, argv });
			assert.equal(claim.outcome, 'won');
			assert.match(claim.notes.join('\n'), /orphan of an earlier configuration \(version 100, not 200\)/);
			assert.notEqual(argvOf(pidOf(child)), null, 'the orphan was signalled with stopOrphans off');
		})
	));

test('stopOrphans signals that same orphan, and says so without claiming an outcome it did not watch for', () =>
	withTempDir('guard-lock-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), 'old-release-stopped'];
			const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
			seedLock(lockPath(dir, 'upgrade'), { pid: pidOf(child), version: 100, argv });

			const claim = await claimLock({
				pidDir: dir,
				name: 'upgrade',
				version: 200,
				argv,
				stopOrphans: true,
			});
			assert.equal(claim.outcome, 'won');
			assert.match(claim.notes.join('\n'), new RegExp(`pid ${pidOf(child)} is an orphan .* It was sent SIGTERM`));
			await waitFor(() => argvOf(pidOf(child)) === null, 'the orphan to exit on the signal it was sent');
		})
	));

test(
	'an orphan that ignores SIGTERM is signalled once and the lock taken in the same pass, so the caller returns',
	{ timeout: slow(10_000) },
	(t) => {
		if (
			skipOnWindows(
				t,
				'nothing on Windows can ignore a terminate, so an orphan that outlives its SIGTERM cannot be arranged; ' +
					'that the claimant signals once, takes the lock in the same pass and chases nothing goes uncovered there.'
			)
		)
			return;
		return withTempDir('guard-lock-', async (dir) =>
			withSpawn(async ({ spawn }) => {
				// Nothing here can make this process exit, so only the claimant's own structure ends the call.
				const argv = [process.execPath, fixture('stubborn.js'), 'ignores-sigterm'];
				const child = spawn(process.execPath, argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
				assert.equal(await readyLine(child), 'ready');
				seedLock(lockPath(dir, 'wedge'), { pid: pidOf(child), version: 100, argv });

				const claim = await claimLock({
					pidDir: dir,
					name: 'wedge',
					version: 200,
					argv,
					timeoutMs: 1000,
					stopOrphans: true,
				});
				assert.equal(claim.outcome, 'won');
				if (claim.outcome !== 'won') return;
				assert.equal(readLock(lockPath(dir, 'wedge'))?.token, claim.token, 'the lock was not taken in that pass');
				// Nothing chases it, and the note says so rather than reporting a death nobody observed.
				assert.equal(isAlive(pidOf(child)), true, 'something escalated past the one SIGTERM');
				assert.match(claim.notes.join('\n'), /nothing chases it if it ignores the signal/);
			})
		);
	}
);

test('an unfinished claim whose host is dead is taken over', () =>
	withTempDir('guard-lock-', async (dir) => {
		const gone = await deadPid();
		seedLock(lockPath(dir, 'abandoned'), { pid: 0, host: gone, version: 1, argv: ['/bin/thing'] });

		const claim = await claimLock({ pidDir: dir, name: 'abandoned', version: 1, argv: ['/bin/thing'] });
		assert.equal(claim.outcome, 'won');
		assert.match(claim.notes.join('\n'), new RegExp(`took over an unfinished claim from pid ${gone}`));
	}));

test('an unfinished claim whose host is alive is waited on, not raced', () =>
	withTempDir('guard-lock-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), 'committed'];
			seedLock(lockPath(dir, 'inflight'), { pid: 0, host: process.pid, version: 1, argv });

			let settled = false;
			const claim = claimLock({ pidDir: dir, name: 'inflight', version: 1, argv, timeoutMs: 5000 }).then((result) => {
				settled = true;
				return result;
			});
			await settle(100);
			assert.equal(settled, false, 'the waiter raced a live claim instead of waiting on it');

			// The claimant names its process, and the waiter joins that rather than starting a second one.
			const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
			seedLock(lockPath(dir, 'inflight'), { pid: pidOf(child), version: 1, argv });
			assert.deepEqual(await claim, {
				outcome: 'adopted',
				pid: pidOf(child),
				notes: [`inflight: joined the running pid ${pidOf(child)} rather than starting a second one.`],
			});
		})
	));

test('an unfinished claim outlives its budget and is taken over, so one wedged thread cannot hold the lock forever', () =>
	withTempDir('guard-lock-', async (dir) => {
		seedLock(lockPath(dir, 'wedged'), { pid: 0, host: process.pid, version: 1, argv: ['/bin/thing'] });
		const claim = await claimLock({
			pidDir: dir,
			name: 'wedged',
			version: 1,
			argv: ['/bin/thing'],
			timeoutMs: 50,
		});
		assert.equal(claim.outcome, 'won');
		assert.match(claim.notes.join('\n'), /took over an unfinished claim/);
	}));

test(
	'a gate held by a live process is broken once the budget runs out, so a claim cannot wait on it forever',
	{ timeout: slow(5000) },
	() =>
		withTempDir('guard-lock-', async (dir) => {
			// A thread killed inside the gate leaves a holder pid that answers as alive, so only the deadline clears it.
			fs.writeFileSync(`${lockPath(dir, 'gated')}.claiming`, String(process.pid), 'utf-8');

			const started = Date.now();
			const claim = await claimLock({ pidDir: dir, name: 'gated', version: 1, argv: ['/bin/thing'], timeoutMs: 200 });
			assert.equal(claim.outcome, 'won');
			assert.ok(Date.now() - started < slow(2000), `a 200ms budget took ${Date.now() - started}ms`);
			assert.equal(fs.existsSync(`${lockPath(dir, 'gated')}.claiming`), false, 'the gate was left behind');
		})
);

test(
	'a gate whose holder is dead is cleared on the spot, so a claim does not spend its whole budget on it',
	{ timeout: slow(10_000) },
	() =>
		withTempDir('guard-lock-', async (dir) => {
			// A claimant that could only wait out a dead holder's gate would spend its whole budget uncontended.
			const gone = await deadPid();
			const gate = `${lockPath(dir, 'stale-gate')}.claiming`;
			fs.writeFileSync(gate, String(gone), 'utf-8');

			const started = Date.now();
			const claim = await claimLock({
				pidDir: dir,
				name: 'stale-gate',
				version: 1,
				argv: ['/bin/thing'],
				timeoutMs: slow(5000),
			});
			const waited = Date.now() - started;

			assert.equal(claim.outcome, 'won');
			assert.ok(waited < slow(1000), `a gate held by dead pid ${gone} cost ${waited}ms of a ${slow(5000)}ms budget`);
			assert.equal(fs.existsSync(gate), false, 'the gate was left behind');
		})
);

test('a claim whose publish cannot land leaves no temp file behind', () =>
	withTempDir('guard-lock-', async (dir) => {
		// A directory where the lock must go lets the temp write land and makes the rename fail.
		fs.mkdirSync(lockPath(dir, 'blocked'));
		await assert.rejects(claimLock({ pidDir: dir, name: 'blocked', version: 1, argv: ['/bin/thing'] }));
		assert.deepEqual(fs.readdirSync(dir), ['blocked.pid'], 'a failed claim left its temp file in the pidDir');
	}));

test('commitLock refuses once the lock has changed hands', () =>
	withTempDir('guard-lock-', async (dir) => {
		const claim = await claimLock({ pidDir: dir, name: 'moved', version: 1, argv: ['/bin/thing'] });
		assert.equal(claim.outcome, 'won');
		if (claim.outcome !== 'won') return;
		seedLock(lockPath(dir, 'moved'), { pid: 4242, token: 'somebody-else', version: 1, argv: ['/bin/thing'] });

		assert.equal(await commitLock(lockPath(dir, 'moved'), claim.token, 777, 1, ['/bin/thing']), 'taken');
		assert.equal(readLock(lockPath(dir, 'moved'))?.pid, 4242, "a lost claimant stamped its pid on the winner's lock");
	}));

test('releaseLock removes only its own lock', () =>
	withTempDir('guard-lock-', async (dir) => {
		const claim = await claimLock({ pidDir: dir, name: 'released', version: 1, argv: ['/bin/thing'] });
		assert.equal(claim.outcome, 'won');
		if (claim.outcome !== 'won') return;

		assert.equal(await releaseLock(lockPath(dir, 'released'), 'not-my-token'), 'taken');
		assert.equal(fs.existsSync(lockPath(dir, 'released')), true);
		assert.equal(await releaseLock(lockPath(dir, 'released'), claim.token), 'written');
		assert.equal(fs.existsSync(lockPath(dir, 'released')), false);
	}));

test('safeLockWrite reports a resolved false from commitLock, not the silent success a discarded boolean would read as', () =>
	withTempDir('guard-lock-', async (dir) => {
		const claim = await claimLock({ pidDir: dir, name: 'stolen', version: 1, argv: ['/bin/thing'] });
		assert.equal(claim.outcome, 'won');
		if (claim.outcome !== 'won') return;
		// Another claimant's lock under its own token, which commitLock's token check guards against.
		seedLock(lockPath(dir, 'stolen'), { pid: 4242, token: 'somebody-else', version: 1, argv: ['/bin/thing'] });

		const failure = await safeLockWrite(commitLock(lockPath(dir, 'stolen'), claim.token, 777, 1, ['/bin/thing']));
		assert.equal(failure, 'the lock changed hands before this write landed');
		assert.equal(readLock(lockPath(dir, 'stolen'))?.pid, 4242, "a lost claimant's commit stamped the winner's lock");
	}));

test('safeLockWrite tells a lock that is gone from one another thread took, which are not the same event', () =>
	withTempDir('guard-lock-', async (dir) => {
		const claim = await claimLock({ pidDir: dir, name: 'vanished', version: 1, argv: ['/bin/thing'] });
		assert.equal(claim.outcome, 'won');
		if (claim.outcome !== 'won') return;
		// A reaper removes the lock before signalling, so this release finds nothing and no other thread.
		fs.rmSync(lockPath(dir, 'vanished'));

		const failure = await safeLockWrite(releaseLock(lockPath(dir, 'vanished'), claim.token));
		assert.equal(failure, 'the lock was already gone when this write landed');
	}));

test('a lock file with no guard record reads as a lock with no record, not as a parse failure', () =>
	withTempDir('guard-lock-', (dir) => {
		// A host's own pid file, which shares the directory and must never be mistaken for one of these.
		const file = path.join(dir, 'foreign.pid');
		fs.writeFileSync(file, '4242\n');
		assert.deepEqual(readLock(file), { pid: 4242, version: 0, token: '', host: 0, argv: [] });
		assert.equal(readLock(path.join(dir, 'absent.pid')), null);
		fs.writeFileSync(file, 'not-a-pid\n');
		assert.equal(readLock(file), null);
	}));

const PLATFORMS = /** @type {NodeJS.Platform[]} */ (['linux', 'darwin', 'win32']);

/** adjudicate checks that the pid the lock names is alive and identifies it inside the gate, through its keeper when
 * its own argv does not match, a read no win32 probe makes. @param {NodeJS.Platform} platform */
const gateHold = (platform) =>
	aliveBudgetMs(platform) + identifyBudgetMs(platform) + (platform === 'win32' ? 0 : identifyBudgetMs(platform));

/**
 * What a thread that entered claimLock beside the claimant waits through until the claim commits, step by step.
 *
 * @param {NodeJS.Platform} platform @returns {[string, number][]}
 */
function claimantPath(platform) {
	const alive = aliveBudgetMs(platform);
	// describeHandedBackPid checks the pid is alive, then reads its command line; a pid-less spawn waits instead.
	const spawn = Math.max(alive + identifyBudgetMs(platform), START_FAILURE_MS);
	return [
		['a round in the gate that ends "cannot tell"', gateHold(platform)],
		['the claimant finding the gate free, one check of its holder late', alive],
		["the claimant's own round, which publishes the unfinished claim", gateHold(platform)],
		["the first spawn, of the reaper or of a keeper's launcher", spawn],
		['the second, under the other command', spawn],
		['a keeper and its launcher starting before the keeper commits', keeperBootMs(platform)],
		['the commit waiting on the gate', gateWaitMs(platform)],
		["its last check of the gate's holder", alive],
		[
			"a status read on the claimant's thread at a yield, where currentReaper identifies twice",
			2 * identifyBudgetMs(platform),
		],
	];
}

test('a writer outlasts the longest gate hold before it breaks the gate, on every platform', () => {
	for (const platform of PLATFORMS) {
		assert.ok(
			gateWaitMs(platform) > gateHold(platform),
			`${platform}: a writer breaks the gate after ${gateWaitMs(platform)}ms, inside a ${gateHold(platform)}ms hold`
		);
	}
});

test('a waiter beside the claimant outlasts its whole path to a committed lock, on every platform', () => {
	for (const platform of PLATFORMS) {
		const steps = claimantPath(platform);
		const total = steps.reduce((sum, [, ms]) => sum + ms, 0);
		assert.ok(
			claimTimeoutMs(platform) > total,
			`${platform}: a waiter takes the claim over at ${claimTimeoutMs(platform)}ms, and the claimant can take ` +
				`${total}ms to commit: ${steps.map(([step, ms]) => `${step} ${ms}ms`).join('; ')}`
		);
	}
	assert.equal(CLAIM_TIMEOUT_MS, claimTimeoutMs(), 'the default claim budget is not the one for this platform');
});

test(
	'a writer waits out the longest gate hold before it breaks a gate, so no live thread is left inside one',
	// Costs the gate wait in wall clock, because the wait it measures is the subject.
	{ timeout: slow(30_000) },
	() =>
		withTempDir('guard-lock-', async (dir) => {
			// A live holder leaves only the budget to clear it.
			const file = lockPath(dir, 'held');
			seedLock(file, { pid: process.pid, token: 'ours', argv: ['/bin/thing'] });
			fs.writeFileSync(`${file}.claiming`, String(process.pid), 'utf-8');

			const started = Date.now();
			assert.equal(await commitLock(file, 'ours', 4242, 1, ['/bin/thing']), 'written', 'the write never landed');
			const waited = Date.now() - started;

			// The probes are not all the gate covers, so a writer clearing them by a millisecond has no margin.
			const rest = 500;
			const hold = gateHold(process.platform);
			assert.ok(waited >= hold + rest, `the gate was broken after ${waited}ms, inside a ${hold}ms hold`);
			assert.equal(readLock(file)?.pid, 4242);
		})
);
