// @ts-check
// A host ends and replaces worker threads routinely, and the thread that started a process is one of them. Real
// threads, ended the way a host ends them, because only a real thread takes its event loop with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { guard } from '../../src/index.js';
import { identify, isAlive } from '../../src/identity.js';
import { lockPath, readLock } from '../../src/lock.js';
import { superviseProcess } from '../../src/supervise.js';
import {
	captureLog,
	context,
	countRunning,
	fixture,
	processTable,
	settle,
	skipOnWindows,
	slow,
	waitFor,
	withSpawn,
	withTempDir,
} from '../support/harness.js';

const NO_KEEPER =
	'no keeper runs on win32, where a stop by pid reaches a process as a crash, so a deliberate stop is restarted ' +
	'there with or without the thread that started it.';
const NO_THREAD_LEFT =
	'no keeper runs on win32, so there a crash with no thread left watching waits for a thread to call guard() ' +
	'again, which README.md says.';
const NO_ZOMBIE = 'Windows leaves no zombie, so there is nothing to count there.';
const NO_RELAY =
	'no keeper runs on win32, so a pipe there is read by the thread that spawned the process and ends it with ' +
	'that thread, which README.md says.';
const NO_HELD_STDIN =
	'no keeper runs on win32, so a piped stdin there is the thread that spawned the process, and reads ' +
	'end-of-file once that thread is gone, which README.md says.';
/** 2 MiB of the talker's 32 KiB rounds. A relay that stopped draining let 9 through on Linux and 5 on macOS. */
const ROUNDS_PAST_THE_BUFFERS = 64;

/** @param {string} name @param {string[]} argv @returns {import('../../src/supervise.js').Descriptor} */
const descriptor = (name, argv) => ({
	name,
	title: name,
	binaryPath: argv[0] ?? '',
	args: argv.slice(1),
	argv,
	spawnOptions: { stdio: 'ignore' },
});

/**
 * `run` beside a worker thread that started the process and stays up until something ends it. The worker is ended
 * and the process it reported is stopped however `run` ends, since without a keeper nothing else stops either.
 *
 * @template T
 * @param {{ pidDir: string, name: string, argv: string[], viaGuard?: boolean, stdio?: import('node:child_process').StdioOptions }} owner
 * @param {(started: { worker: Worker, pid: number, read: number }) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withOwner({ pidDir, name, argv, viaGuard = false, stdio = 'ignore' }, run) {
	const worker = new Worker(path.join(import.meta.dirname, '..', 'support', 'owner-worker.js'), {
		workerData: { pidDir, name, argv, viaGuard, stdio },
	});
	/** @type {number | undefined} */
	let pid;
	try {
		/** @type {{ pid?: number, started?: boolean, adopted?: boolean, error?: string, read?: number }} */
		const result = await new Promise((resolve, reject) => {
			worker.once('message', resolve);
			worker.once('error', reject);
		});
		pid = result.pid;
		assert.equal(result.started, true, `the worker started nothing: ${result.error}`);
		assert.equal(result.adopted, false, 'the worker joined something instead of starting it');
		return await run({ worker, pid: /** @type {number} */ (pid), read: result.read ?? 0 });
	} finally {
		await worker.terminate();
		if (pid !== undefined && identify(pid, argv) === 'match') process.kill(pid, 'SIGKILL');
	}
}

/** Zombies whose parent is this process, which is the host every worker thread here belongs to. */
const zombiesOfThisHost = () =>
	processTable()
		.filter((row) => row.ppid === process.pid && row.stat.startsWith('Z'))
		.map((row) => row.pid);

test('a stop signal is honoured after the thread that started the process is gone', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-gone-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), `gone-stop-${process.pid}`];
			const ctx = context(dir, spawn, { keeper: true });
			try {
				await withOwner({ pidDir: dir, name: 'stopped', argv }, async ({ worker, pid }) => {
					const joiner = await superviseProcess(ctx, descriptor('stopped', argv));
					assert.equal(joiner.pid, pid, 'the joiner is watching some other process');
					await worker.terminate();

					process.kill(pid, 'SIGTERM');
					await waitFor(() => joiner.exited, 'the joiner to see the stop');
					await settle(300);

					assert.equal(countRunning(argv), 0, 'a deliberate stop was restarted');
					assert.equal(fs.existsSync(lockPath(dir, 'stopped')), false, 'the lock outlived a deliberate stop');
					assert.match(ctx.log.lines.info.join('\n'), /was shut down \(signal SIGTERM\); not restarting it/);
				});
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a crash is restarted with no thread left watching the process', (t) => {
	if (skipOnWindows(t, NO_THREAD_LEFT)) return;
	return withTempDir('guard-gone-', (dir) => {
		const argv = [process.execPath, fixture('idle.js'), `gone-crash-${process.pid}`];
		return withOwner({ pidDir: dir, name: 'unwatched', argv }, async ({ worker, pid }) => {
			await worker.terminate();

			process.kill(pid, 'SIGKILL');
			await waitFor(
				() => {
					const lock = readLock(lockPath(dir, 'unwatched'));
					return lock !== null && lock.pid > 0 && lock.pid !== pid && isAlive(lock.pid);
				},
				'a replacement started with no thread to start it',
				{ timeoutMs: slow(10_000) }
			);
			assert.equal(countRunning(argv), 1);
		});
	});
});

test('deaths after the thread that started the process is gone leave no zombie on the host', (t) => {
	if (skipOnWindows(t, NO_ZOMBIE)) return;
	return withTempDir('guard-gone-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const before = new Set(zombiesOfThisHost());
			const argv = [process.execPath, fixture('idle.js'), `gone-reaped-${process.pid}`];
			const ctx = context(dir, spawn, { keeper: true });
			try {
				await withOwner({ pidDir: dir, name: 'reaped', argv }, async ({ worker, pid }) => {
					const joiner = await superviseProcess(ctx, descriptor('reaped', argv));
					await worker.terminate();

					// A crash that is restarted, then a stop that is not: both ways this process can end.
					process.kill(pid, 'SIGKILL');
					await waitFor(
						() => joiner.started && !joiner.exited && joiner.pid !== pid,
						'the joiner to follow the replacement'
					);
					process.kill(/** @type {number} */ (joiner.pid), 'SIGTERM');
					await waitFor(() => joiner.exited, 'the joiner to see the stop');
					await settle(200);

					const left = zombiesOfThisHost().filter((zombie) => !before.has(zombie));
					assert.deepEqual(left, [], 'a death left a zombie that nothing on this host will ever reap');
				});
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

// The pack hour of 2026-09-30: the reaper was killed after Harper had replaced every worker, and stayed a zombie of it.
test('a reaper killed after the thread that launched it is gone leaves no zombie on the host', (t) => {
	if (skipOnWindows(t, NO_ZOMBIE)) return;
	return withTempDir('guard-gone-', async (dir) => {
		const before = new Set(zombiesOfThisHost());
		const worker = new Worker(path.join(import.meta.dirname, '..', 'support', 'reaper-owner-worker.js'), {
			workerData: { pidDir: dir, name: 'reaper' },
		});
		/** @type {number | undefined} */
		let pid;
		try {
			/** @type {{ pid?: number, started?: boolean, error?: string }} */
			const launched = await new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
			pid = launched.pid;
			assert.equal(launched.started, true, `the worker launched no reaper: ${launched.error}`);
			await worker.terminate();
			const parent = processTable().find((row) => row.pid === pid)?.ppid;

			process.kill(/** @type {number} */ (pid), 'SIGKILL');
			await waitFor(() => !isAlive(/** @type {number} */ (pid)), 'the reaper to die');
			await settle(200);
			const left = zombiesOfThisHost().filter((zombie) => !before.has(zombie));
			assert.deepEqual(left, [], 'the reaper died a zombie that nothing on this host will ever reap');
			assert.notEqual(parent, process.pid, 'the reaper was a child of the host, which only its spawning thread reaps');
		} finally {
			await worker.terminate();
			if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
		}
	});
});

test('a process whose output its thread reads through a pipe outlives that thread, and goes on writing', (t) => {
	if (skipOnWindows(t, NO_RELAY)) return;
	return withTempDir('guard-gone-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const progress = path.join(dir, 'rounds');
			const argv = [process.execPath, fixture('talker.js'), progress, `gone-piped-${process.pid}`];
			const rounds = () => Number(fs.readFileSync(progress, 'utf-8'));
			const ctx = context(dir, spawn, { keeper: true });
			try {
				await withOwner({ pidDir: dir, name: 'piped', argv, stdio: 'pipe' }, async ({ worker, pid, read }) => {
					assert.ok(read > 0, 'nothing the process wrote reached the thread reading its pipe');
					const joiner = await superviseProcess(ctx, descriptor('piped', argv));
					await worker.terminate();
					await settle(100);
					const before = rounds();
					const since = () => rounds() - before;

					// A count, not a rate: a loaded macOS runner wrote 14 rounds in the second this once allowed.
					await waitFor(() => since() >= ROUNDS_PAST_THE_BUFFERS, 'the process to go on writing', {
						timeoutMs: slow(30_000),
					}).catch(() => assert.fail(`the process stalled on a pipe nothing reads: ${since()} rounds`));
					assert.equal(identify(pid, argv), 'match', 'the process died once the thread reading it was gone');
					assert.equal(countRunning(argv), 1);
					assert.equal(joiner.exited, false, 'the joiner saw a death');
					assert.equal(joiner.restarts, 0);
				});
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a piped stdin reads no end-of-file while its keeper runs, whether or not the thread that piped it does', (t) => {
	if (skipOnWindows(t, NO_HELD_STDIN)) return;
	return withTempDir('guard-gone-', (dir) => {
		const eof = path.join(dir, 'eof');
		const argv = [process.execPath, fixture('stdin-reader.js'), eof, `gone-stdin-${process.pid}`];
		return withOwner({ pidDir: dir, name: 'reader', argv, stdio: 'pipe' }, async ({ worker, pid }) => {
			await settle(300);
			assert.equal(fs.existsSync(eof), false, 'the process read end-of-file while its thread was still up');
			await worker.terminate();
			await settle(1000);

			assert.equal(fs.existsSync(eof), false, 'the process read end-of-file once its thread was gone');
			assert.equal(identify(pid, argv), 'match', 'the process is not running under its first pid');
			const keeper = readLock(lockPath(dir, 'reader'))?.keeper;
			assert.ok(typeof keeper === 'number' && keeper > 0, 'the lock names no keeper');
			process.kill(keeper, 'SIGKILL');
			await waitFor(() => fs.existsSync(eof), 'the process to read end-of-file once its keeper was gone');
		});
	});
});

test(
	'guard() starts the process under a keeper, so a stop after its thread is gone is honoured',
	{ timeout: slow(60_000) },
	(t) => {
		if (skipOnWindows(t, NO_KEEPER)) return;
		return withTempDir('guard-gone-', (dir) =>
			withSpawn(async ({ spawn }) => {
				const argv = [process.execPath, fixture('idle.js'), `gone-guard-${process.pid}`];
				await withOwner({ pidDir: dir, name: 'agent', argv, viaGuard: true }, async ({ worker, pid }) => {
					const joined = await guard({
						pidDir: dir,
						spawn,
						log: captureLog(),
						version: 1,
						processes: [{ name: 'agent', binaryPath: process.execPath, args: argv.slice(1) }],
					});
					try {
						const joiner = joined.processes[0];
						assert.equal(joiner?.pid, pid, 'the second caller did not join the first');
						assert.equal(typeof readLock(lockPath(dir, 'agent'))?.keeper, 'number', 'guard() started no keeper');
						await worker.terminate();

						process.kill(pid, 'SIGTERM');
						// guard() polls every two seconds and would restart one second later, so this window sees either.
						await waitFor(() => joiner?.exited === true, 'the joiner to see the stop', { timeoutMs: slow(10_000) });
						await settle(1500);
						assert.equal(countRunning(argv), 0, 'a deliberate stop was restarted');
					} finally {
						joined.stop();
					}
				});
			})
		);
	}
);
