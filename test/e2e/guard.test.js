// @ts-check
// Real worker threads and real processes, because a version that mocks the interleavings proves nothing about them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { isAlive } from '../../src/identity.js';
import { lockPath, readLock } from '../../src/lock.js';
import {
	countRunning,
	fixture,
	readyLine,
	settle,
	skipOnWindows,
	slow,
	waitFor,
	withSpawn,
	withTempDir,
} from '../support/harness.js';

const THREADS = 8;

test('eight worker threads calling guard() leave one process running on the node', { timeout: slow(60_000) }, () =>
	withTempDir('guard-e2e-', async (dir) => {
		// Every thread of a host reaches this call, and without arbitration that is eight processes.
		const tag = `e2e-one-winner-${process.pid}`;
		const args = [fixture('idle.js'), tag];
		const argv = [process.execPath, ...args];
		const workers = Array.from(
			{ length: THREADS },
			() =>
				new Worker(path.join(import.meta.dirname, '..', 'support', 'guard-worker.js'), {
					workerData: { pidDir: dir, binaryPath: process.execPath, args },
				})
		);

		try {
			const results = await Promise.all(
				workers.map(
					(worker) =>
						new Promise((resolve, reject) => {
							worker.once('message', resolve);
							worker.once('error', reject);
						})
				)
			);

			assert.equal(countRunning(argv), 1, 'more than one process was started for one declared process');
			// The other direction, because a counter stuck at 1 would read as one winner however many there were.
			assert.equal(countRunning([...argv, 'never-spawned']), 0, 'a command line nothing runs was counted');
			const starters = results.filter((r) => r.started && !r.adopted);
			assert.equal(starters.length, 1, `${starters.length} threads believed they started it`);
			assert.equal(new Set(results.map((r) => r.pid)).size, 1, 'the threads disagree about which process is theirs');
			assert.equal(readLock(lockPath(dir, 'shared'))?.pid, results[0].pid);
		} finally {
			await Promise.all(workers.map((worker) => worker.terminate()));
			for (const line of fs.readdirSync(dir)) {
				const lock = readLock(path.join(dir, line));
				if (lock && lock.pid > 0) {
					try {
						process.kill(lock.pid, 'SIGKILL');
					} catch {
						// Already gone.
					}
				}
			}
		}
	})
);

test('a killed host does not leave its process behind', { timeout: slow(60_000) }, () =>
	withTempDir('guard-e2e-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `e2e-reaped-${process.pid}`;
			const host = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
			const started = JSON.parse(await readyLine(host));

			assert.equal(started.reaper.started, true, `the reaper did not start: ${started.reaper.error}`);
			assert.equal(isAlive(started.guarded), true);
			assert.equal(countRunning([process.execPath, fixture('idle.js'), tag]), 1);

			// SIGKILL runs no shutdown hook or handler, so only something outside the host can stop what it started.
			host.kill('SIGKILL');
			// The lock first: on Windows the guarded process dies with its host, so only the lock shows the reaper.
			await waitFor(() => !fs.existsSync(lockPath(dir, 'guarded')), 'the reaper to answer for the lock it watched', {
				timeoutMs: slow(30_000),
				intervalMs: 100,
			});
			await waitFor(() => !isAlive(started.guarded), 'the process its host left behind to stop', {
				timeoutMs: slow(30_000),
				intervalMs: 100,
			});
			await waitFor(() => !fs.existsSync(lockPath(dir, 'reaper')), 'the reaper to remove its own lock');
		})
	)
);

test(
	'a real SIGTERM to the reaper itself removes its own lock, leaving the host and its process alone',
	{ timeout: slow(30_000) },
	(t) => {
		if (
			skipOnWindows(
				t,
				'a Windows process cannot be sent SIGTERM: process.kill terminates the reaper before its handler runs, ' +
					'so the handler at src/reaper.js:197 is inert there and the reaper leaves its own lock behind. ' +
					'Neither the cleanup nor that leak is covered on Windows.'
			)
		)
			return;
		return withTempDir('guard-e2e-', (dir) =>
			withSpawn(async ({ spawn }) => {
				const tag = `e2e-reaper-sigterm-${process.pid}`;
				const host = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
				const started = JSON.parse(await readyLine(host));

				try {
					assert.equal(started.reaper.started, true, `the reaper did not start: ${started.reaper.error}`);
					assert.equal(fs.existsSync(lockPath(dir, 'reaper')), true);

					// Its first log line proves the signal handler exists; a SIGTERM before it would race Node's startup.
					const reaperLog = path.join(dir, 'reaper.log');
					await waitFor(
						() => fs.existsSync(reaperLog) && fs.readFileSync(reaperLog, 'utf-8').includes('watching pid'),
						'the reaper to finish starting up'
					);

					process.kill(started.reaper.pid, 'SIGTERM');
					await waitFor(
						() => !fs.existsSync(lockPath(dir, 'reaper')),
						'the reaper to remove its own lock after SIGTERM',
						{
							timeoutMs: slow(10_000),
							intervalMs: 50,
						}
					);

					// The reaper was told to stop, not the host: hostPid never went, so nothing here should reap.
					assert.equal(isAlive(host.pid ?? -1), true, 'the host was affected by a signal sent only to its reaper');
					assert.equal(isAlive(started.guarded), true, 'the guarded process was reaped although its host is alive');
					assert.equal(fs.existsSync(lockPath(dir, 'guarded')), true, "the guarded process's lock was removed");
				} finally {
					// The reaper is stopped and the guarded process is a plain child of `host`, so nothing else reaps it.
					try {
						process.kill(started.guarded, 'SIGKILL');
					} catch {
						// Already gone.
					}
				}
			})
		);
	}
);

test(
	'a second host started beside the first joins its process rather than starting another',
	{ timeout: slow(60_000) },
	() =>
		withTempDir('guard-e2e-', (dir) =>
			withSpawn(async ({ spawn }) => {
				const tag = `e2e-two-hosts-${process.pid}`;
				const first = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
				const one = JSON.parse(await readyLine(first));
				const second = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
				const two = JSON.parse(await readyLine(second));

				assert.equal(two.guarded, one.guarded, 'the second host started its own copy');
				assert.equal(countRunning([process.execPath, fixture('idle.js'), tag]), 1);
				// Its reaper watches a different host, so its command line differs and it takes its own turn.
				assert.equal(two.reaper.started, true);

				first.kill('SIGKILL');
				second.kill('SIGKILL');
				await waitFor(() => !isAlive(one.guarded), 'the process to be stopped once both hosts are gone', {
					timeoutMs: slow(30_000),
					intervalMs: 100,
				});
			})
		)
);

test(
	'two hosts that joined a third keep its process running when that third host is killed under them',
	{ timeout: slow(120_000) },
	() =>
		withTempDir('guard-e2e-', (dir) =>
			withSpawn(async ({ spawn }) => {
				const tag = `e2e-survivor-${process.pid}`;
				const argv = [process.execPath, fixture('idle.js'), tag];
				const startHost = () =>
					spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });

				const owner = startHost();
				const started = JSON.parse(await readyLine(owner));
				const survivors = [startHost(), startHost()];
				const joined = [];
				for (const host of survivors) joined.push(JSON.parse(await readyLine(host)));

				assert.deepEqual(
					joined.map((result) => result.guarded),
					[started.guarded, started.guarded],
					'a host that should have joined started its own copy'
				);
				assert.equal(countRunning(argv), 1);

				try {
					// Only the lock holder goes; its reaper stops the process the other two joined, and they must replace it.
					owner.kill('SIGKILL');
					await waitFor(
						() => !isAlive(started.guarded),
						"the killed host's reaper to stop the process the survivors joined",
						{ timeoutMs: slow(30_000), intervalMs: 100 }
					);
					await waitFor(() => countRunning(argv) >= 1, 'a surviving host to replace what it was left supervising', {
						timeoutMs: slow(60_000),
						intervalMs: 200,
					});

					// Both survivors answer the same death, and only the lock keeps that to one process.
					await settle(3000);
					assert.equal(countRunning(argv), 1, 'two hosts answered one death with two processes');
					const replacement = readLock(lockPath(dir, 'guarded'))?.pid;
					assert.notEqual(replacement, started.guarded, 'the lock still names the process that was stopped');
					assert.equal(isAlive(replacement ?? -1), true, 'the lock names a replacement that is not running');
					for (const host of survivors) assert.equal(isAlive(host.pid ?? -1), true, 'a survivor died on its own');
					// A survivor took the reaper lock for its own reaper, and the killed host's reaper leaving must not remove it.
					const reaper = readLock(lockPath(dir, 'reaper'))?.pid ?? 0;
					assert.ok(
						joined.some((result) => result.reaper.pid === reaper) && isAlive(reaper),
						`the reaper lock names ${reaper || 'nothing'}, not a survivor's running reaper`
					);
				} finally {
					// Killing the survivors leaves the replacement to their reapers, and waiting proves nothing stayed.
					const left = readLock(lockPath(dir, 'guarded'))?.pid ?? 0;
					for (const host of survivors) host.kill('SIGKILL');
					try {
						await waitFor(() => countRunning(argv) === 0, "the survivors' reapers to stop the replacement", {
							timeoutMs: slow(30_000),
							intervalMs: 100,
						});
					} finally {
						try {
							if (left > 0) process.kill(left, 'SIGKILL');
						} catch {
							// Already gone, which is the outcome asked for.
						}
					}
				}
			})
		)
);
