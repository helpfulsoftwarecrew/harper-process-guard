// @ts-check
// The keeper: a process between the guard and what it guards, so a death's exit status and its reaping belong to
// no single worker thread. Every case here runs real processes and reads what they and the lock did.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { argvOf, identify, isAlive } from '../../src/identity.js';
import { guard } from '../../src/index.js';
import { claimLock, lockPath, readLock } from '../../src/lock.js';
import { nodeProcess } from '../../src/node.js';
import { reapTarget, run } from '../../src/reaper.js';
import { superviseProcess } from '../../src/supervise.js';
import {
	context,
	countRunning,
	deadPid,
	fixture,
	KEEPER_SCRIPT,
	pidOf,
	processTable,
	readyLine,
	seedLock,
	settle,
	skipOnWindows,
	slow,
	tuning,
	waitFor,
	withSpawn,
	withTempDir,
} from '../support/harness.js';

const NO_KEEPER =
	'no keeper runs on win32, which leaves no zombie; guard() spawns the process itself there, which ' +
	'test/unit/supervise.test.js covers.';

/**
 * Tagged last with this file's pid, so a count of the process table sees only this case's processes and not
 * another file's copy of the same fixture. The fixtures read nothing past their own arguments.
 *
 * @param {string} name @param {string} script @param {string[]} [args] @returns {import('../../src/supervise.js').Descriptor}
 */
function descriptorFor(name, script, args = []) {
	const binaryPath = process.execPath;
	const all = [fixture(script), ...args, `keep-${name}-${process.pid}`];
	return { name, title: name, binaryPath, args: all, argv: [binaryPath, ...all], spawnOptions: { stdio: 'ignore' } };
}

/** @param {string} dir @param {import('../../src/supervise.js').Spawn} spawn @param {Parameters<typeof context>[2]} [overrides] */
const keptContext = (dir, spawn, overrides = {}) => context(dir, spawn, { keeper: true, ...overrides });

/** What the keeper last wrote beside the lock, read off the disk rather than through the module that writes it. @param {string} dir @param {string} name */
function exitRecord(dir, name) {
	try {
		return JSON.parse(fs.readFileSync(`${lockPath(dir, name)}.exit`, 'utf-8'));
	} catch {
		return null;
	}
}

/** The keeper a lock names. Never 0, which kill(2) reads as this whole process group. @param {string} dir @param {string} name */
function keeperOf(dir, name) {
	const keeper = readLock(lockPath(dir, name))?.keeper;
	if (typeof keeper !== 'number' || keeper <= 0) throw new Error(`the ${name} lock names no keeper`);
	return keeper;
}

/** Executable, so preflight passes, but unrunnable, so only the keeper's own spawn finds out.
 * @param {string} dir @param {NodeJS.ProcessEnv} [env] @returns {import('../../src/supervise.js').Descriptor} */
function unrunnable(dir, env) {
	const wrapper = path.join(dir, 'unrunnable.sh');
	fs.writeFileSync(wrapper, '#!/nonexistent/interpreter\necho started\n', 'utf-8');
	fs.chmodSync(wrapper, 0o755);
	return {
		name: 'unrunnable',
		title: 'unrunnable thing',
		binaryPath: wrapper,
		args: [],
		argv: [wrapper],
		spawnOptions: env ? { stdio: 'ignore', env } : { stdio: 'ignore' },
	};
}

/** This environment with `script` preloaded into every node the guard starts, the keeper among them.
 * @param {string} script @param {NodeJS.ProcessEnv} more */
function preloading(script, more) {
	const preload = `--import="${pathToFileURL(fixture(script)).href}"`;
	return { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim(), ...more };
}

test('the keeper is the parent of the process it starts, and no thread of this host is the parent of the keeper', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptorFor('parented', 'idle.js'));
				assert.equal(state.started, true, `nothing started: ${state.error}`);
				const lock = readLock(lockPath(dir, 'parented'));
				assert.equal(lock?.pid, state.pid);
				assert.equal(typeof lock?.keeper, 'number', 'the lock records no keeper');
				assert.equal(lock?.host, process.pid, 'the lock names the keeper as its holder, not the host that launched it');

				const table = processTable();
				const row = (/** @type {number | undefined} */ pid) => table.find((entry) => entry.pid === pid);
				assert.equal(row(state.pid)?.ppid, lock?.keeper, "the process is not the keeper's child");
				assert.notEqual(row(lock?.keeper)?.ppid, process.pid, 'the keeper is a child of this host after all');
				// The thread spawned only the launcher, and reaped it before returning.
				assert.deepEqual(
					calls.map((call) => call.args[0]),
					[KEEPER_SCRIPT]
				);
				assert.deepEqual(
					table.filter((entry) => entry.ppid === process.pid && entry.stat.startsWith('Z')),
					[],
					'the launcher was left a zombie'
				);
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a clean exit under a keeper is a shutdown: the keeper releases the lock and nothing starts it again', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const ctx = keptContext(dir, spawn);
			const descriptor = descriptorFor('clean', 'quits.js', ['0', '200']);
			try {
				const state = await superviseProcess(ctx, descriptor);
				await waitFor(() => state.exited, 'the clean exit');
				assert.equal(state.code, 0);
				assert.match(ctx.log.lines.info.join('\n'), /was shut down \(exit code 0\); not restarting it/);
				await waitFor(() => !fs.existsSync(lockPath(dir, 'clean')), 'the keeper to remove the lock after its record');
				await settle(150);

				assert.equal(exitRecord(dir, 'clean')?.outcome, 'released');
				assert.equal(countRunning(descriptor.argv), 0, 'a deliberate shutdown was started again');
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a death its thread sees before the keeper has recorded it is reported with how it ended, never without', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const ctx = keptContext(dir, spawn);
			try {
				for (const [name, script, args, ended] of /** @type {const} */ ([
					['exits', 'quits.js', ['0', '200'], { code: 0, signal: undefined }],
					['stopped', 'idle.js', [], { code: undefined, signal: 'SIGTERM' }],
				])) {
					const env = preloading('slow-record.js', {
						GUARD_SLOW_RECORD: lockPath(dir, name),
						GUARD_SLOW_RECORD_MS: '400',
					});
					const base = descriptorFor(name, script, [...args]);
					const state = await superviseProcess(ctx, { ...base, spawnOptions: { stdio: 'ignore', env } });
					assert.equal(state.started, true, `${name} did not start: ${state.error}`);
					if (ended.signal) process.kill(/** @type {number} */ (state.pid), ended.signal);
					await waitFor(() => state.exited, `the thread to report ${name}'s death`, { intervalMs: 1 });

					assert.deepEqual({ code: state.code, signal: state.signal }, ended, `${name} was reported dead before how`);
					assert.equal(exitRecord(dir, name)?.outcome, 'released');
				}
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('what a process writes just before it exits reaches the thread reading its pipes, since its keeper waits for it', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	const bytes = 1 << 20;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const read = { stdout: 0, stderr: 0 };
			let ended = 0;
			/** @type {import('../../src/supervise.js').Spawn} */
			const reading = (command, args, options) => {
				const child = spawn(command, args, options);
				for (const name of /** @type {const} */ (['stdout', 'stderr'])) {
					const stream = child[name];
					let since = 0;
					// A pause every 64 KiB, so the keeper still holds output when the process exits.
					stream?.on('data', (chunk) => {
						read[name] += chunk.length;
						since += chunk.length;
						if (since < 1 << 16) return;
						since = 0;
						stream.pause();
						setTimeout(() => stream.resume(), 20);
					});
					stream?.on('end', () => (ended += 1));
				}
				return child;
			};
			const ctx = keptContext(dir, reading);
			const descriptor = {
				...descriptorFor('burst', 'burst.js', [String(bytes)]),
				spawnOptions: { stdio: /** @type {import('node:child_process').StdioOptions} */ (['ignore', 'pipe', 'pipe']) },
			};
			try {
				await superviseProcess(ctx, descriptor);
				await waitFor(() => ended === 2, 'both pipes to end');

				assert.deepEqual(read, { stdout: bytes, stderr: bytes }, 'output written before the exit was lost');
				assert.equal(exitRecord(dir, 'burst')?.outcome, 'released');
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a crash is restarted by the keeper, and the thread follows each replacement without spawning one', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptorFor('crashy', 'quits.js', ['3', '100']));
				const seen = new Set([state.pid]);
				await waitFor(() => {
					const pid = readLock(lockPath(dir, 'crashy'))?.pid;
					if (pid) seen.add(pid);
					return seen.size >= 3;
				}, 'the keeper to answer the crash more than once');
				await waitFor(() => state.restarts >= 1 && seen.has(state.pid), 'the thread to join a replacement');

				assert.equal(calls.length, 1, 'a thread spawned again for a crash its keeper answers');
				assert.match(ctx.log.lines.warn.join('\n'), /exit code 3/);
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('the keeper caps its restarts, releases the lock, and the thread reports what is missing', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = keptContext(dir, spawn, { tuning: tuning({ restartMax: 2, restartBaseMs: 5 }) });
			try {
				const state = await superviseProcess(ctx, descriptorFor('doomed', 'quits.js', ['9', '10']));
				await waitFor(() => state.error !== undefined, 'the cap to be reached');
				assert.match(state.error ?? '', /died 3 times \(exit code 9\); not restarting it again/);
				await settle(150);

				assert.equal(calls.length, 1, 'a thread started it again past the cap');
				assert.equal(exitRecord(dir, 'doomed')?.outcome, 'gave-up');
				assert.equal(fs.existsSync(lockPath(dir, 'doomed')), false, 'a keeper that gave up left its lock');
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a process a sibling stopped for a new version is not restarted by its keeper, nor called a shutdown', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const descriptor = descriptorFor('handed-over', 'idle.js');
			const victim = keptContext(dir, spawn);
			const stopper = keptContext(dir, spawn, { version: 2, stopOrphans: true });
			try {
				const state = await superviseProcess(victim, descriptor);
				await superviseProcess(stopper, descriptor);
				await waitFor(() => state.exited, 'the victim to see its process stopped');
				await settle(150);

				assert.equal(exitRecord(dir, 'handed-over')?.outcome, 'taken');
				assert.match(victim.log.lines.warn.join('\n'), /was stopped \(signal SIGTERM\) by whatever now holds/);
				assert.equal(victim.log.lines.info.join('\n').includes('was shut down'), false);
				assert.deepEqual(victim.log.lines.error, []);
				assert.equal(countRunning(descriptor.argv), 1, 'the node does not run exactly one after the handover');
			} finally {
				victim.run.stopping = true;
				stopper.run.stopping = true;
			}
		})
	);
});

test('a process that cannot run is reported from the keeper in the words a direct spawn uses, and no lock is left', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const ctx = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(ctx, unrunnable(dir));
				assert.equal(state.started, false, 'a process that never ran was reported as started');
				assert.equal(state.pid, undefined);
				assert.match(state.error ?? '', /the unrunnable thing failed to start: spawn .*unrunnable\.sh ENOENT/);
				assert.deepEqual(ctx.report, [state.error]);
				assert.equal(ctx.log.lines.error.length, 1, `one failure was logged as ${ctx.log.lines.error.length} lines`);
				assert.equal(fs.existsSync(lockPath(dir, 'unrunnable')), false, 'the claim was left behind');
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a thread that reads a failed start while its keeper is removing the lock leaves the lock to the keeper', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	const holdMs = 800;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const lock = lockPath(dir, 'unrunnable');
			const env = preloading('slow-unlink.js', { GUARD_SLOW_UNLINK: lock, GUARD_SLOW_UNLINK_MS: String(holdMs) });
			const ctx = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(ctx, unrunnable(dir, env));
				assert.match(state.error ?? '', /the unrunnable thing failed to start: spawn .*unrunnable\.sh ENOENT/);
				assert.equal(ctx.log.lines.error.length, 1, `one failure was logged as ${ctx.log.lines.error.length} lines`);
				assert.equal(fs.existsSync(lock), true, 'the lock was gone when the thread answered, outside the held unlink');
				const keeper = exitRecord(dir, 'unrunnable')?.keeper;
				assert.ok(typeof keeper === 'number' && keeper > 0, 'the record names no keeper');
				await waitFor(() => !fs.existsSync(lock) && !isAlive(keeper), 'the keeper to remove its lock and exit');
				assert.equal(ctx.log.lines.error.length, 1, 'something was logged once the keeper removed its lock');
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a failed start whose keeper cannot release the lock is still reported by why it never ran, and the claim goes back', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const lock = lockPath(dir, 'unrunnable');
			const ctx = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(
					ctx,
					unrunnable(dir, preloading('refused-gate.js', { GUARD_REFUSED_GATE: lock }))
				);
				assert.match(
					state.error ?? '',
					/the unrunnable thing failed to start: spawn .*unrunnable\.sh ENOENT \(its keeper could not release the lock: EPERM/
				);
				assert.equal(exitRecord(dir, 'unrunnable')?.released, false);
				assert.equal(fs.existsSync(lock), false, 'the thread kept a claim its keeper could not give back');
				assert.equal(ctx.log.lines.error.length, 1, `one failure was logged as ${ctx.log.lines.error.length} lines`);
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a process that ends before its thread reads its pid is answered from the record its keeper left, not as a lost claim', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	// Native and gone within a millisecond, so its keeper commits and releases between two of the thread's looks.
	const [quick = '', failing = ''] = [
		['/usr/bin/true', '/bin/true'],
		['/usr/bin/false', '/bin/false'],
	].map((paths) => paths.find((file) => fs.existsSync(file)) ?? '');
	/** @param {string} name @param {string} binaryPath @returns {import('../../src/supervise.js').Descriptor} */
	const native = (name, binaryPath) => ({
		name,
		title: name,
		binaryPath,
		args: [],
		argv: [binaryPath],
		spawnOptions: { stdio: 'ignore' },
	});
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = keptContext(dir, spawn);
			const capped = keptContext(dir, spawn, { tuning: tuning({ restartMax: 0 }) });
			try {
				for (const round of [1, 2, 3, 4, 5]) {
					const state = await superviseProcess(ctx, native(`instant-${round}`, quick));
					assert.equal(state.started, true, `round ${round} reported no start: ${state.error}`);
					await waitFor(() => state.exited, `round ${round}'s exit to be answered`);
					assert.equal(state.code, 0);
					assert.equal(state.error, undefined, `round ${round}: ${state.error}`);
					await waitFor(() => !fs.existsSync(lockPath(dir, `instant-${round}`)), `round ${round}'s lock to go`);
				}
				assert.deepEqual(ctx.report, [], 'a clean exit was reported as a refusal');
				assert.equal(ctx.log.lines.info.join('\n').match(/was shut down \(exit code 0\)/g)?.length, 5);

				const crashed = await superviseProcess(capped, native('instant-crash', failing));
				assert.equal(crashed.started, true, `a crash past the cap reported no start: ${crashed.error}`);
				await waitFor(() => crashed.error !== undefined, 'the crash to be answered');
				assert.match(crashed.error ?? '', /died 1 times \(exit code 1\); not restarting it again/);
				assert.equal(calls.length, 6, 'a thread started one of them again');
			} finally {
				ctx.run.stopping = true;
				capped.run.stopping = true;
			}
		})
	);
});

test('a process whose keeper was killed is not restarted when it dies, however it died, and the next claim starts it', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const descriptor = descriptorFor('keeperless', 'idle.js');
			const ctx = keptContext(dir, spawn);
			const later = keptContext(dir, spawn);
			try {
				// Nothing can read an orphan's exit status, so a stop and a crash look the same to the thread.
				for (const signal of /** @type {const} */ (['SIGTERM', 'SIGKILL'])) {
					const state = await superviseProcess(ctx, descriptor);
					assert.equal(state.adopted, false, `the ${signal} round joined what the last round left`);
					const keeper = keeperOf(dir, 'keeperless');
					process.kill(keeper, 'SIGKILL');
					await waitFor(() => !isAlive(keeper), 'the keeper to die');
					process.kill(/** @type {number} */ (state.pid), signal);
					await waitFor(() => state.exited, `the thread to see the ${signal}`);
					// Longer than a keeper takes to start, so a restart would be running by now.
					await settle(1500);

					assert.equal(countRunning(descriptor.argv), 0, `a ${signal} after its keeper was killed was restarted`);
					assert.match(state.error ?? '', /died with its keeper \(pid \d+\) gone/);
				}
				const next = await superviseProcess(later, descriptor);
				assert.equal(next.started && !next.adopted, true, `the next claim did not start it: ${next.error}`);
				assert.equal(countRunning(descriptor.argv), 1);
			} finally {
				ctx.run.stopping = true;
				later.run.stopping = true;
				killTagged(`keep-keeperless-${process.pid}`);
			}
		})
	);
});

test('a process that execs is still ours once its keeper is killed: the next claim joins it, and the reaper stops it', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const execed = [process.execPath, fixture('idle.js'), `orphan-execed-${process.pid}`];
			const script = path.join(dir, 'agent.sh');
			fs.writeFileSync(script, `#!/bin/sh\nexec ${execed.map((arg) => `'${arg}'`).join(' ')}\n`, 'utf-8');
			fs.chmodSync(script, 0o755);
			const name = 'orphan-execed';
			/** @type {import('../../src/supervise.js').Descriptor} */
			const descriptor = {
				name,
				title: name,
				binaryPath: script,
				args: [],
				argv: [script],
				// A zone unlike this host's reaches the keeper, whose start times must still read as this host reads them.
				spawnOptions: { stdio: 'ignore', env: { ...process.env, TZ: 'Pacific/Chatham' } },
			};
			const ctx = keptContext(dir, spawn);
			const later = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptor);
				await waitFor(() => countRunning(execed) === 1, 'the script to exec');
				const keeper = keeperOf(dir, name);
				process.kill(keeper, 'SIGKILL');
				await waitFor(() => !isAlive(keeper), 'the keeper to die');

				const joined = await superviseProcess(later, descriptor);
				assert.equal(joined.adopted, true, `the next claim started a second copy: ${later.report.join(' ')}`);
				assert.equal(joined.pid, state.pid);
				assert.equal(nodeProcess({ name, started: false }, dir).pid, state.pid, 'a status read found nothing');
				await settle(300);
				assert.equal(countRunning(execed), 1, 'the node runs more than one');
				assert.equal(calls.length, 1, 'a thread started it again');

				ctx.run.stopping = true;
				later.run.stopping = true;
				const reaping = { pidDir: dir, hostPid: await deadPid(), graceMs: 0, termGraceMs: slow(1000) };
				await reapTarget(reaping, {
					path: lockPath(dir, name),
					pid: /** @type {number} */ (state.pid),
					argv: [script],
				});
				await waitFor(() => countRunning(execed) === 0, 'the reaper to stop the orphan');
			} finally {
				ctx.run.stopping = true;
				later.run.stopping = true;
				killTagged(`orphan-execed-${process.pid}`);
			}
		})
	);
});

test('a host that refuses node for the keeper still gets its process, started directly, and is told what it lost', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			/** @type {import('../../src/supervise.js').Spawn} */
			const noNode = (command, args, options) => {
				if (args[0] === KEEPER_SCRIPT) throw new Error(`spawn of ${command} is not allowed`);
				return spawn(command, args, options);
			};
			const ctx = keptContext(dir, noNode);
			const descriptor = descriptorFor('unkept', 'idle.js');
			try {
				const state = await superviseProcess(ctx, descriptor);
				assert.equal(state.started, true, `nothing started: ${state.error}`);
				assert.equal(readLock(lockPath(dir, 'unkept'))?.keeper, undefined);
				assert.equal(countRunning(descriptor.argv), 1);
				assert.match(
					ctx.report.join('\n'),
					/the keeper for the unkept could not be started \(.*is not allowed.*\), so this thread starts it itself/
				);
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a death after its lock was removed is not restarted, which is the order the reaper stops a process in', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = keptContext(dir, spawn);
			const descriptor = descriptorFor('reaped', 'idle.js');
			try {
				const state = await superviseProcess(ctx, descriptor);
				const keeper = keeperOf(dir, 'reaped');
				// SIGKILL is what the reaper escalates to, and it is no shutdown, so only the missing lock stops a restart.
				const killed = /** @type {number} */ (state.pid);
				fs.unlinkSync(lockPath(dir, 'reaped'));
				process.kill(killed, 'SIGKILL');
				await waitFor(() => !isAlive(keeper), 'the keeper to stand down');
				await settle(150);

				assert.equal(exitRecord(dir, 'reaped')?.outcome, 'gone');
				assert.equal(
					exitRecord(dir, 'reaped')?.pid,
					killed,
					'the keeper started it again before finding the lock gone'
				);
				assert.equal(countRunning(descriptor.argv), 0, 'the keeper restarted a process whose lock was removed');
				assert.equal(calls.length, 1, 'a thread restarted a process whose lock was removed');
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test('a stop signal sent to the keeper reaches the process, and neither is started again', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const ctx = keptContext(dir, spawn);
			const descriptor = descriptorFor('forwarded', 'idle.js');
			try {
				const state = await superviseProcess(ctx, descriptor);
				// The keeper's handlers exist before it starts the process, so a committed pid proves them there.
				const keeper = keeperOf(dir, 'forwarded');
				process.kill(keeper, 'SIGTERM');
				await waitFor(() => state.exited && !isAlive(keeper), 'the stop to reach the process and the keeper');
				await settle(150);

				assert.equal(exitRecord(dir, 'forwarded')?.signal, 'SIGTERM');
				assert.equal(fs.existsSync(lockPath(dir, 'forwarded')), false);
				assert.equal(countRunning(descriptor.argv), 0);
				assert.match(ctx.log.lines.info.join('\n'), /was shut down \(signal SIGTERM\); not restarting it/);
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test("a stop sent to a keeper during its restart backoff holds for a thread that joined after the lock's host died", (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const descriptor = descriptorFor('backoff-stop', 'idle.js');
			const hostArgs = [fixture('kept-host.js'), dir, descriptor.name, '800', ...descriptor.argv];
			const host = spawn(process.execPath, hostArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
			const reported = JSON.parse(String(await readyLine(host)));
			assert.equal(typeof reported.pid, 'number', `the host started nothing: ${reported.error}`);
			host.kill('SIGKILL');
			await waitFor(() => !isAlive(pidOf(host)), 'the host to die');
			const keeper = keeperOf(dir, descriptor.name);
			// A dead host behind a missing lock reads as a reaper's removal, so only the record says the keeper stopped.
			const ctx = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptor);
				assert.equal(state.adopted, true, `the thread did not join: ${ctx.report.join(' ')}`);
				process.kill(reported.pid, 'SIGKILL');
				await waitFor(() => /Its keeper starts it again/.test(ctx.log.lines.warn.join('\n')), 'the thread to wait');
				process.kill(keeper, 'SIGTERM');
				await waitFor(
					() => /was shut down|Going back through the lock/.test(ctx.log.all().join('\n')),
					'the thread to answer the stop'
				);
				await settle(1000);

				assert.match(ctx.log.lines.info.join('\n'), /was shut down \(.*\); not restarting it/);
				assert.equal(exitRecord(dir, descriptor.name)?.outcome, 'released');
				assert.equal(fs.existsSync(lockPath(dir, descriptor.name)), false);
				assert.equal(countRunning(descriptor.argv), 0, 'a restart undid the stop sent to the keeper');
				assert.equal(calls.length, 1, 'a thread here spawned something');
			} finally {
				ctx.run.stopping = true;
			}
		})
	);
});

test("a restart stopped between a joining thread's read of the lock and its look at the keeper is not started again", (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const descriptor = descriptorFor('held-restart', 'idle.js');
			const lock = lockPath(dir, descriptor.name);
			const marker = path.join(dir, 'joiner-read.mark');
			const env = preloading('held-restart.js', { GUARD_HELD_LOCK: lock, GUARD_HELD_MARKER: marker });
			const hostArgs = [fixture('kept-host.js'), dir, descriptor.name, '800', ...descriptor.argv];
			const host = spawn(process.execPath, hostArgs, { stdio: ['ignore', 'pipe', 'ignore'], env });
			const reported = JSON.parse(String(await readyLine(host)));
			assert.equal(typeof reported.pid, 'number', `the host started nothing: ${reported.error}`);
			host.kill('SIGKILL');
			await waitFor(() => !isAlive(pidOf(host)), 'the host to die');
			const joiner = new Worker(path.join(import.meta.dirname, '..', 'support', 'held-joiner.js'), {
				workerData: { pidDir: dir, lock, marker, descriptor },
			});
			const logOf = async () => {
				const lines = once(joiner, 'message');
				joiner.postMessage('log');
				return /** @type {string[]} */ ((await lines)[0]).join('\n');
			};
			try {
				const [joined] = await once(joiner, 'message');
				assert.equal(joined.adopted, true, `the thread did not join: ${joined.error}`);
				process.kill(reported.pid, 'SIGKILL');
				let restarted = 0;
				await waitFor(() => {
					restarted = readLock(lock)?.pid ?? 0;
					return restarted > 0 && restarted !== reported.pid;
				}, 'the keeper to commit its restart');
				process.kill(restarted, 'SIGTERM');
				await waitFor(async () => /was shut down|Going back/.test(await logOf()), 'the thread to answer the stop');
				await settle(1000);

				assert.equal(fs.existsSync(marker), true, "the thread's read of the lock did not come before the restart");
				assert.equal(countRunning(descriptor.argv), 0, 'the thread started the stopped process again');
				assert.match(await logOf(), /was shut down \(signal SIGTERM\); not restarting it/);
				assert.equal(exitRecord(dir, descriptor.name)?.outcome, 'released');
			} finally {
				await joiner.terminate();
			}
		})
	);
});

test(
	'a commit that lands after its thread stopped waiting keeps its lock, and the next claim joins the one copy',
	{ timeout: slow(60_000) },
	(t) => {
		if (skipOnWindows(t, NO_KEEPER)) return;
		return withTempDir('guard-keep-', (dir) =>
			withSpawn(async ({ spawn }) => {
				const descriptor = descriptorFor('late-commit', 'idle.js');
				const lock = lockPath(dir, descriptor.name);
				// Imported here, so this file still loads against a source that has no keeper budget to read.
				const [{ keeperBootMs, gateWaitMs }, { aliveBudgetMs }] = await Promise.all([
					import('../../src/lock.js'),
					import('../../src/identity.js'),
				]);
				// The thread's wait for its keeper, summed as supervise.js sums it; the commit is held a second past it.
				const deadline = keeperBootMs() + gateWaitMs() + aliveBudgetMs();
				const until = String(Date.now() + deadline + 1000);
				const env = preloading('held-commit.js', { GUARD_HELD_COMMIT: lock, GUARD_HELD_COMMIT_UNTIL: until });
				const first = keptContext(dir, spawn);
				const second = keptContext(dir, spawn);
				try {
					const begun = Date.now();
					const state = await superviseProcess(first, { ...descriptor, spawnOptions: { stdio: 'ignore', env } });
					const waited = Date.now() - begun;
					const joined = await superviseProcess(second, descriptor);
					await settle(500);

					assert.equal(countRunning(descriptor.argv), 1, 'the next claim started a second copy');
					assert.ok(waited > deadline, `the keeper committed after ${waited}ms, inside its thread's wait`);
					assert.equal(state.started, true, `the thread gave up on a process its keeper runs: ${state.error}`);
					assert.equal(readLock(lock)?.pid, state.pid, 'the lock does not name the process the thread reported');
					assert.equal(joined.adopted, true, `the next claim did not join it: ${joined.error}`);
					assert.equal(joined.pid, state.pid);
				} finally {
					first.run.stopping = true;
					second.run.stopping = true;
				}
			})
		);
	}
);

test(
	'a restart a keeper commits while the reaper waits out another process is stopped too, and every keeper goes',
	{ timeout: slow(30_000) },
	(t) => {
		if (skipOnWindows(t, NO_KEEPER)) return;
		return withTempDir('guard-keep-', (dir) =>
			withSpawn(async ({ spawn }) => {
				// Both ignore SIGTERM, so the reaper spends its whole grace on whichever lock it reaches first.
				const descriptors = ['first', 'second'].map((name) => ({
					...descriptorFor(name, 'stubborn.js'),
					spawnOptions: {
						stdio: /** @type {import('node:child_process').StdioOptions} */ (['ignore', 'pipe', 'ignore']),
					},
				}));
				/** @type {Promise<unknown>[]} */
				const announced = [];
				/** @type {import('../../src/supervise.js').Spawn} */
				const listening = (command, args, options) => {
					const child = spawn(command, args, options);
					// Read from the start: Node drains a pipe nobody reads once the launcher holding it exits.
					announced.push(readyLine(child));
					return child;
				};
				const ctx = keptContext(dir, listening);
				try {
					for (const descriptor of descriptors) {
						const state = await superviseProcess(ctx, descriptor);
						assert.equal(state.started, true, `nothing started: ${state.error}`);
					}
					// A launcher's stdout reaches its process through the keeper, and "ready" follows the SIGTERM handler.
					const ready = await Promise.race([Promise.all(announced), settle(5000).then(() => 'no ready line in 5s')]);
					assert.deepEqual(ready, ['ready', 'ready']);
					// No thread answers anything from here on, as when the host is dead.
					ctx.run.stopping = true;
					const reaping = run({ hostPid: await deadPid(), pidDir: dir, graceMs: 0, termGraceMs: slow(1500) });

					/** @type {import('../../src/supervise.js').Descriptor | undefined} */
					let later;
					await waitFor(() => {
						const taken = descriptors.filter((descriptor) => !fs.existsSync(lockPath(dir, descriptor.name)));
						if (taken.length !== 1) return false;
						later = descriptors.find((descriptor) => !taken.includes(descriptor));
						return true;
					}, 'the reaper to take the first lock and wait on its process');
					const name = /** @type {import('../../src/supervise.js').Descriptor} */ (later).name;
					const crashed = /** @type {number} */ (readLock(lockPath(dir, name))?.pid);
					process.kill(crashed, 'SIGKILL');
					await waitFor(() => {
						const pid = readLock(lockPath(dir, name))?.pid ?? 0;
						return pid > 0 && pid !== crashed;
					}, 'its keeper to commit a restart while the reaper waits');

					await reaping;
					await settle(200);
					for (const descriptor of descriptors) {
						assert.equal(countRunning(descriptor.argv), 0, `the ${descriptor.name} process outlived the reaper`);
					}
					await waitFor(
						() => !processTable().some((row) => row.args.includes(KEEPER_SCRIPT) && row.args.includes(dir)),
						'every keeper to stand down once its lock was gone'
					);
					assert.deepEqual(
						fs.readdirSync(dir).filter((file) => file.endsWith('.pid')),
						[],
						'a lock outlived the reaper'
					);
				} finally {
					ctx.run.stopping = true;
				}
			})
		);
	}
);

test('a process that execs into another command line is joined after its keeper restarts it, and nothing starts a second', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			// The lock and every thread name the script; what runs under its pid is node on idle.js.
			const execed = [process.execPath, fixture('idle.js'), `execed-${process.pid}`];
			const script = path.join(dir, 'agent.sh');
			fs.writeFileSync(script, `#!/bin/sh\nexec ${execed.map((arg) => `'${arg}'`).join(' ')}\n`, 'utf-8');
			fs.chmodSync(script, 0o755);
			/** @type {import('../../src/supervise.js').Descriptor} */
			const descriptor = {
				name: 'execed',
				title: 'execed',
				binaryPath: script,
				args: [],
				argv: [script],
				spawnOptions: { stdio: 'ignore' },
			};
			const ctx = keptContext(dir, spawn);
			const sibling = keptContext(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptor);
				const first = state.pid;
				await waitFor(() => countRunning(execed) === 1, 'the script to exec');
				process.kill(/** @type {number} */ (first), 'SIGKILL');
				await waitFor(
					() => state.pid !== first && state.adopted && !state.exited,
					"the thread to join its keeper's restart",
					{
						timeoutMs: slow(5000),
					}
				);
				assert.match(ctx.log.lines.info.join('\n'), /runs again under its keeper/);

				const joined = await superviseProcess(sibling, descriptor);
				assert.equal(joined.adopted, true, `a second thread started its own: ${sibling.report.join(' ')}`);
				assert.equal(joined.pid, state.pid);
				assert.equal(
					nodeProcess({ name: 'execed', started: false }, dir).pid,
					state.pid,
					'a status read found nothing'
				);
				await settle(300);
				assert.equal(countRunning(execed), 1, 'the node runs more than one');
				assert.equal(calls.length, 1, 'a thread spawned again for a restart its keeper made');
			} finally {
				ctx.run.stopping = true;
				sibling.run.stopping = true;
			}
		})
	);
});

// The rule the keeper's restarts depend on: while it restarts, the lock names a dead pid and a live keeper.
test('a lock naming a dead pid whose keeper still runs is waited on, because that keeper owes a restart', () =>
	withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), 'kept-process'];
			const keeperArgv = [process.execPath, fixture('idle.js'), 'stand-in-keeper'];
			const keeper = spawn(process.execPath, keeperArgv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(keeper)) !== null, 'the keeper to appear in the process table');
			const file = lockPath(dir, 'restarting');
			seedLock(file, { pid: await deadPid(), argv, keeper: pidOf(keeper), keeperArgv });

			let settled = false;
			const claim = claimLock({ pidDir: dir, name: 'restarting', version: 1, argv, timeoutMs: slow(5000) }).then(
				(result) => {
					settled = true;
					return result;
				}
			);
			await settle(200);
			assert.equal(settled, false, 'a lock its keeper is restarting was taken, which starts a second process');

			const replacement = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(replacement)) !== null, 'the replacement to appear in the process table');
			seedLock(file, { pid: pidOf(replacement), argv, keeper: pidOf(keeper), keeperArgv });
			const outcome = await claim;
			assert.equal(outcome.outcome, 'adopted');
			assert.equal(outcome.outcome === 'adopted' ? outcome.pid : 0, pidOf(replacement));
		})
	));

test('NEGATIVE: a lock naming a dead pid and a dead keeper is reclaimed at once', () =>
	withTempDir('guard-keep-', async (dir) => {
		const argv = ['/bin/thing'];
		seedLock(lockPath(dir, 'abandoned'), { pid: await deadPid(), argv, keeper: await deadPid(), keeperArgv: ['x'] });
		const claim = await claimLock({ pidDir: dir, name: 'abandoned', version: 1, argv, timeoutMs: slow(5000) });
		assert.equal(claim.outcome, 'won');
	}));

test('NEGATIVE: a keeper pid now running something else holds nothing', () =>
	withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const stranger = spawn(process.execPath, [fixture('idle.js'), 'not-a-keeper'], { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(stranger)) !== null, 'the stranger to appear in the process table');
			const argv = ['/bin/thing'];
			seedLock(lockPath(dir, 'recycled'), {
				pid: await deadPid(),
				argv,
				keeper: pidOf(stranger),
				keeperArgv: [process.execPath, KEEPER_SCRIPT, '--keep', '--lock', lockPath(dir, 'recycled')],
			});
			const claim = await claimLock({ pidDir: dir, name: 'recycled', version: 1, argv, timeoutMs: slow(5000) });
			assert.equal(claim.outcome, 'won');
		})
	));

test('a keeper that never restarts is outlasted: the claim budget still takes the lock', () =>
	withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const keeperArgv = [process.execPath, fixture('idle.js'), 'wedged-keeper'];
			const keeper = spawn(process.execPath, keeperArgv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(keeper)) !== null, 'the keeper to appear in the process table');
			const argv = ['/bin/thing'];
			seedLock(lockPath(dir, 'wedged'), { pid: await deadPid(), argv, keeper: pidOf(keeper), keeperArgv });
			const claim = await claimLock({ pidDir: dir, name: 'wedged', version: 1, argv, timeoutMs: 100 });
			assert.equal(claim.outcome, 'won');
		})
	));

/**
 * A live shell and its one child, strangers to every keeper: what a keeper's pid and its process's pid can pass to once
 * both are gone. Killing the shell orphans the child, so the caller kills the child.
 *
 * @param {import('../../src/supervise.js').Spawn} spawn @param {string} tag
 */
async function strangers(spawn, tag) {
	// The `:` keeps the shell from exec'ing into its child.
	const shell = spawn('/bin/sh', ['-c', `'${process.execPath}' '${fixture('idle.js')}' ${tag}; :`], {
		stdio: 'ignore',
	});
	let child = 0;
	await waitFor(() => {
		child = processTable().find((row) => row.ppid === pidOf(shell) && row.args.includes(tag))?.pid ?? 0;
		return child > 0;
	}, 'the stranger to start its child');
	return { parent: pidOf(shell), child };
}

/** Killed if still there; a test that found it signalled has already failed on that. @param {number} pid */
function killQuietly(pid) {
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// Already gone.
	}
}

/** Kills whatever carries `tag`: an orphan of a killed keeper has init for its parent, so no keeper cleanup finds it. @param {string} tag */
function killTagged(tag) {
	for (const { pid } of processTable().filter((row) => row.args.includes(tag))) killQuietly(pid);
}

/** The leading run a keeper holding `file` under seedLock's token would have recorded. @param {string} file */
const keeperArgvFor = (file) => [process.execPath, KEEPER_SCRIPT, '--keep', '--lock', file, '--token', 'seeded'];

/** A lock whose keeper and process are gone and whose two pids now name `pair`, the keeper's command line intact.
 * @param {string} file @param {{ parent: number, child: number }} pair @param {readonly string[]} argv */
async function seedReused(file, pair, argv) {
	const host = await deadPid();
	seedLock(file, { pid: pair.child, argv, keeper: pair.parent, keeperArgv: keeperArgvFor(file), host });
}

test('NEGATIVE: a stranger on a reused keeper pid vouches for its child to no claim and no status read', (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const pair = await strangers(spawn, `reused-${process.pid}`);
			const argv = ['/opt/agent/bin/agent', 'run'];
			try {
				await seedReused(lockPath(dir, 'claimed'), pair, argv);
				const claim = await claimLock({ pidDir: dir, name: 'claimed', version: 1, argv, timeoutMs: slow(5000) });
				assert.equal(claim.outcome, 'won', "a claim joined a stranger's child, so nothing starts the process");

				await seedReused(lockPath(dir, 'read'), pair, argv);
				const read = nodeProcess({ name: 'read', started: false }, dir);
				assert.equal(read.started, false, `a status read reported the stranger's child ${read.pid} as the process`);
			} finally {
				killQuietly(pair.child);
			}
		})
	);
});

test("NEGATIVE: a stranger's child on a reused keeper pid is signalled by neither a new version's claim nor the reaper", (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const pair = await strangers(spawn, `signalled-${process.pid}`);
			const argv = ['/opt/agent/bin/agent', 'run'];
			try {
				await seedReused(lockPath(dir, 'orphaned'), pair, argv);
				const options = { pidDir: dir, name: 'orphaned', version: 2, argv, timeoutMs: slow(5000), stopOrphans: true };
				const claim = await claimLock(options);
				assert.equal(claim.outcome, 'won');
				await settle(300);
				assert.equal(isAlive(pair.child), true, "a new version's claim signalled the stranger's child");

				const file = lockPath(dir, 'reaped');
				await seedReused(file, pair, argv);
				const reaping = { pidDir: dir, hostPid: await deadPid(), graceMs: 0, termGraceMs: 500 };
				await reapTarget(reaping, { path: file, pid: pair.child, argv });
				await settle(300);
				assert.equal(isAlive(pair.child), true, "the reaper signalled the stranger's child");
				assert.equal(fs.existsSync(file), false, 'the reaper left the lock');
			} finally {
				killQuietly(pair.child);
			}
		})
	);
});

test("NEGATIVE: a thread following its keeper's restart joins no child of a stranger that took the keeper's pid", (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const descriptor = descriptorFor('rejoined', 'idle.js');
			const pair = await strangers(spawn, `rejoined-${process.pid}`);
			// No keeper of its own: this thread only joins, which is where it learns the keeper it follows.
			const ctx = context(dir, spawn);
			try {
				const first = spawn(descriptor.binaryPath, [...descriptor.args], { stdio: 'ignore' });
				await waitFor(() => argvOf(pidOf(first)) !== null, 'the process to appear in the process table');
				const file = lockPath(dir, 'rejoined');
				const kept = { argv: descriptor.argv, keeper: pair.parent, keeperArgv: keeperArgvFor(file) };
				seedLock(file, { pid: pidOf(first), ...kept, host: await deadPid() });
				const state = await superviseProcess(ctx, descriptor);
				assert.equal(state.adopted, true, `the thread did not join: ${ctx.report.join(' ')}`);

				// A keeper's announcement of a restart, then a lock naming the stranger's child as that restart.
				const restarting = { token: 'seeded', keeper: pair.parent, pid: pidOf(first), code: 3, signal: null };
				const record = {
					...restarting,
					outcome: 'restarting',
					restarts: 1,
					waitMs: 0,
					at: Date.now(),
					released: false,
				};
				fs.writeFileSync(`${file}.exit`, JSON.stringify(record), 'utf-8');
				await seedReused(file, pair, descriptor.argv);
				process.kill(pidOf(first), 'SIGKILL');
				await waitFor(
					() => state.pid !== pidOf(first) && state.started && !state.exited,
					'the thread to settle on a process after the death'
				);

				assert.notEqual(state.pid, pair.child, "the thread joined the stranger's child as its process");
				assert.equal(identify(/** @type {number} */ (state.pid), descriptor.argv), 'match');
				assert.equal(countRunning(descriptor.argv), 1);
			} finally {
				ctx.run.stopping = true;
				killQuietly(pair.child);
			}
		})
	);
});

test("status.stop() ends this thread's watch and not the keeper: a crash after it is restarted, and the next call joins", (t) => {
	if (skipOnWindows(t, NO_KEEPER)) return;
	return withTempDir('guard-keep-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const { binaryPath, args, argv } = descriptorFor('after-stop', 'idle.js');
			const declared = { name: 'after-stop', binaryPath, args: [...args] };
			const status = await guard({ pidDir: dir, spawn, version: 1, processes: [declared] });
			const first = /** @type {number} */ (status.processes[0]?.pid);
			assert.equal(status.processes[0]?.started, true, `nothing started: ${status.report.join(' ')}`);
			status.stop();
			process.kill(first, 'SIGKILL');
			await waitFor(() => {
				const pid = readLock(lockPath(dir, 'after-stop'))?.pid ?? 0;
				return pid > 0 && pid !== first && isAlive(pid);
			}, 'the keeper to restart a crash after stop()');
			assert.equal(status.processes[0]?.pid, first, 'a stopped thread followed the restart');

			const next = await guard({ pidDir: dir, spawn, version: 1, processes: [declared] });
			try {
				assert.equal(next.processes[0]?.adopted, true, `the next call started its own: ${next.report.join(' ')}`);
				assert.equal(countRunning(argv), 1);
			} finally {
				next.stop();
			}
		})
	);
});
