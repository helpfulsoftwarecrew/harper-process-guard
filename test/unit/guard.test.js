// @ts-check
// What guard() composes: one state per declared process, the report, and an ordering that decides
// whether a host killed mid-verify leaves its processes behind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { fingerprint, guard } from '../../src/index.js';
import { isAlive } from '../../src/identity.js';
import { lockPath, readLock } from '../../src/lock.js';
import {
	captureLog,
	countRunning,
	fixture,
	readyLine,
	REPO_ROOT,
	seedLock,
	skipOnWindows,
	slow,
	waitFor,
	WINDOWS,
	withSpawn,
	withTempDir,
} from '../support/harness.js';

/** The reaper this package spawns, so a stub can refuse it by name without touching the guarded processes. */
const REAPER_SCRIPT = path.join(REPO_ROOT, 'src', 'reaper.js');

/** What rename(2) onto a directory reports. The Windows half is an expectation this machine cannot check;
 * its CI leg settles which code arrives, and a wrong guess fails that step rather than passing quietly. */
const RENAME_ONTO_DIR = WINDOWS ? /EISDIR|EPERM|EACCES/ : /EISDIR/;

/** @param {string} tag @param {string} [name] */
const declare = (tag, name = 'agent') => ({ name, binaryPath: process.execPath, args: [fixture('idle.js'), tag] });

/** @param {import('../../src/index.js').ReaperState | undefined} reaper */
function stopReaper(reaper) {
	if (typeof reaper?.pid !== 'number') return;
	try {
		process.kill(reaper.pid, 'SIGKILL');
	} catch {
		// Already gone, which is the outcome asked for.
	}
}

/**
 * A host process on disk: whether guard() releases the event loop, and what the reaper it spawned was
 * told, cannot be seen from inside the process that called guard().
 *
 * @param {string} dir Written here, which is also the pidDir every caller passes; a `.js` is not a `.pid`.
 * @param {object} options guard() options, minus the spawn the script supplies itself.
 * @param {{ park?: boolean }} [shape] park keeps the host up until something kills it, the way a host stays up.
 * @returns {string} Path of the script.
 */
function writeHost(dir, options, { park = false } = {}) {
	const file = path.join(dir, 'host-variant.js');
	const module = pathToFileURL(path.join(REPO_ROOT, 'src', 'index.js')).href;
	fs.writeFileSync(
		file,
		[
			`import { spawn } from 'node:child_process';`,
			`import { guard } from ${JSON.stringify(module)};`,
			`const result = await guard({ ...${JSON.stringify(options)}, spawn });`,
			`process.stdout.write(JSON.stringify({ guarded: result.processes[0]?.pid, reaper: result.reaper }) + '\\n');`,
			...(park ? ['setInterval(() => {}, 1 << 30);'] : []),
		].join('\n'),
		'utf-8'
	);
	return file;
}

test('a fingerprint is a number a host can parseInt, and it moves when its inputs do', () => {
	const first = fingerprint('config', 'key');
	assert.equal(Number.isInteger(first), true);
	assert.ok(first >= 0 && first < 2 ** 31, `${first} is outside the range a host will parse`);
	assert.equal(first, fingerprint('config', 'key'));
	assert.notEqual(first, fingerprint('config', 'other'));
	// Joined with a separator, so two parts cannot collide with one longer one.
	assert.notEqual(fingerprint('ab', 'c'), fingerprint('a', 'bc'));
});

test('one state per declared process, in declaration order', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `call-order-${process.pid}`;
			const result = await guard({
				pidDir: dir,
				spawn,
				processes: [declare(`${tag}-a`, 'first'), declare(`${tag}-b`, 'second')],
			});
			try {
				assert.deepEqual(
					result.processes.map((state) => state.name),
					['first', 'second']
				);
				assert.equal(
					result.processes.every((state) => state.started),
					true
				);
				assert.equal(result.reaper, undefined, 'a reaper was launched without being asked for');
			} finally {
				result.stop();
			}
		})
	));

test("a caller's verify verdict lands on the state and in the log", () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const log = captureLog();
			const result = await guard({
				pidDir: dir,
				spawn,
				log,
				processes: [
					{ ...declare(`verify-ok-${process.pid}`, 'good'), verify: async () => ({ ok: true, detail: 'answered' }) },
					{
						...declare(`verify-bad-${process.pid}`, 'bad'),
						verify: async () => {
							throw new Error('the probe never answered');
						},
					},
				],
			});
			try {
				assert.equal(result.processes[0]?.verified, true);
				assert.equal(result.processes[0]?.verifyDetail, 'answered');
				assert.equal(result.processes[1]?.verified, false);
				assert.equal(result.processes[1]?.verifyDetail, 'the probe never answered');
				assert.match(log.lines.error.join('\n'), /the bad failed verification: the probe never answered/);
			} finally {
				result.stop();
			}
		})
	));

// A reaper that is a thread of the host stops nothing when the host goes.
test('NEGATIVE: a reaper spawn that hands back a pid running something else is refused, and the guard says so', () =>
	withTempDir('guard-reaper-', async (dir) =>
		withSpawn(async ({ spawn }) => {
			/** @type {import('../../src/supervise.js').Spawn} */
			const strangerForReaper = (command, args, options) =>
				String(args[0]).endsWith('reaper.js')
					? /** @type {any} */ ({ pid: process.pid, on() {}, once() {}, unref() {}, kill() {} })
					: spawn(command, args, options);
			const log = captureLog();
			const status = await guard({
				pidDir: dir,
				spawn: strangerForReaper,
				log,
				processes: [{ name: 'one', binaryPath: process.execPath, args: [fixture('idle.js')] }],
				reaper: { name: 'reaper' },
			});
			try {
				assert.equal(status.reaper?.started, false);
				assert.match(status.reaper?.error ?? '', /handed back pid \d+, which is running/);
				assert.equal(fs.existsSync(lockPath(dir, 'reaper')), false, 'a refused reaper left its lock behind');
			} finally {
				status.stop();
				for (const state of status.processes) if (state.pid) process.kill(state.pid, 'SIGKILL');
			}
		})
	));

test('the reaper is launched before any verify, so a host killed inside a probe leaves nothing behind', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// A probe can wait 30 seconds, which is the window this ordering covers.
			let reaperWasUp = false;
			const result = await guard({
				pidDir: dir,
				spawn,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [
					{
						...declare(`ordering-${process.pid}`),
						verify: async () => {
							reaperWasUp = fs.existsSync(lockPath(dir, 'reaper'));
							return { ok: true };
						},
					},
				],
			});
			try {
				assert.equal(result.reaper?.started, true, `the reaper did not start: ${result.reaper?.error}`);
				assert.equal(reaperWasUp, true, 'verify ran before the reaper was up');
			} finally {
				result.stop();
				stopReaper(result.reaper);
			}
		})
	));

// Harper's constrained spawn throws without options.name, where a fake spawn would accept anything.
test('every process guard spawns, including the reaper, names itself in the spawn options', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const tag = `name-option-${process.pid}`;
			const result = await guard({
				pidDir: dir,
				spawn,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(tag, 'named-agent')],
			});
			try {
				assert.equal(calls.length, 2, 'expected one spawn for the process and one for the reaper');
				for (const call of calls) {
					assert.ok(call.options.name, `${call.command} ${call.args.join(' ')} spawned with no name option`);
				}
				assert.deepEqual(calls.map((call) => call.options.name).sort(), ['named-agent', 'reaper'].sort());
			} finally {
				result.stop();
				stopReaper(result.reaper);
			}
		})
	));

test('a host that refuses every command it is offered says so instead of failing quietly', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			let allowed = 0;
			const result = await guard({
				pidDir: dir,
				spawn: (command, args, options) => {
					// Only the reaper's command is refused, as by an allowlist without either spelling of node.
					if (++allowed > 1) throw new Error(`spawn of ${command} is not allowed`);
					return spawn(command, args, options);
				},
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(`refused-reaper-${process.pid}`)],
			});
			try {
				assert.equal(result.reaper?.started, false);
				assert.match(result.reaper?.error ?? '', /is not allowed/);
				assert.match(result.report.join('\n'), /will keep running after this host stops/);
				assert.equal(fs.existsSync(lockPath(dir, 'reaper')), false, 'a reaper lock outlived a reaper that never ran');
			} finally {
				result.stop();
			}
		})
	));

test('a reaper whose spawn fails after returning is reported, not recorded as watching', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// The asynchronous twin of the refusal above: the exec fails after spawn returns, so nothing throws.
			let spawned = 0;
			const result = await guard({
				pidDir: dir,
				spawn: (command, args, options) =>
					// A missing interpreter fails at exec with no pid, where a missing script would spawn and fail later.
					++spawned > 1 ? spawn(path.join(dir, 'no-such-interpreter'), args, options) : spawn(command, args, options),
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(`async-reaper-${process.pid}`)],
			});
			try {
				assert.equal(result.reaper?.started, false, 'a reaper that never executed was reported as started');
				assert.equal(result.reaper?.pid, undefined);
				assert.match(result.reaper?.error ?? '', /ENOENT|Cannot find module/);
				assert.match(result.report.join('\n'), /will keep running after this host stops/);
				assert.equal(fs.existsSync(lockPath(dir, 'reaper')), false, 'the reaper lock was left pinned at pid 0');
			} finally {
				result.stop();
			}
		})
	));

test('a reaper whose first command fails after returning falls back to the second, which is why the loop exists', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// A child with no pid that reports through 'error', which the synchronous refusal above cannot produce.
			const log = captureLog();
			const result = await guard({
				pidDir: dir,
				spawn: (command, args, options) =>
					command === process.execPath && args[0] === REAPER_SCRIPT
						? spawn(path.join(dir, 'no-such-interpreter'), args, options)
						: spawn(command, args, options),
				log,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(`fallback-reaper-${process.pid}`)],
			});
			try {
				assert.equal(result.reaper?.started, true, `the fallback was never reached: ${result.reaper?.error}`);
				assert.equal(result.reaper?.command, 'node');
				assert.equal(isAlive(/** @type {number} */ (result.reaper?.pid)), true);
				assert.equal(readLock(lockPath(dir, 'reaper'))?.pid, result.reaper?.pid, 'the lock kept the refused attempt');
				// The refused candidate had no pid, so its 'error' is the spawn failing rather than the reaper.
				assert.deepEqual(log.lines.error, [], 'a spawn that never ran was reported as a reaper that failed to execute');
			} finally {
				result.stop();
				stopReaper(result.reaper);
			}
		})
	));

test('a claimLock failure while launching the reaper does not take the already-started processes down with it', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// A directory where the reaper's lock goes reads as unheld, and renaming the claim onto it throws.
			fs.mkdirSync(lockPath(dir, 'reaper'));
			const result = await guard({
				pidDir: dir,
				spawn,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(`reaper-lock-fail-${process.pid}`)],
			});
			try {
				assert.equal(
					result.processes[0]?.started,
					true,
					'the reaper lock failure took an already-started process down with it'
				);
				assert.equal(result.reaper?.started, false);
				assert.match(result.reaper?.error ?? '', RENAME_ONTO_DIR);
			} finally {
				result.stop();
			}
		})
	));

test('a host that permits only a bare `node` gets one reaper, not one per caller', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// Harper's allowlist defaults to [npm, node] and matches the first word, so the absolute path is refused.
			/** @type {import('../../src/supervise.js').Spawn} */
			const onlyNode = (command, args, spawnOptions) => {
				if (command === process.execPath && args[0] === REAPER_SCRIPT)
					throw new Error(`spawn of ${command} is not allowed`);
				return spawn(command, args, spawnOptions);
			};
			const tag = `bare-node-${process.pid}`;
			const first = await guard({
				pidDir: dir,
				spawn: onlyNode,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(tag)],
			});
			const second = await guard({
				pidDir: dir,
				spawn: onlyNode,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(tag)],
			});
			try {
				assert.equal(first.reaper?.command, 'node', `the fallback was not taken: ${first.reaper?.error}`);
				assert.equal(second.reaper?.adopted, true, 'the second caller started a second reaper');
				assert.equal(second.reaper?.pid, first.reaper?.pid);
			} finally {
				first.stop();
				second.stop();
				stopReaper(first.reaper);
			}
		})
	));

test(
	'a host that returns from guard() exits, because the reaper it left running does not hold its event loop',
	{ timeout: slow(60_000) },
	() =>
		withTempDir('guard-call-', (dir) =>
			withSpawn(async ({ spawn }) => {
				// Nothing is declared, so the reaper's child handle is the only one that could hold the host open.
				const script = writeHost(dir, { pidDir: dir, processes: [], reaper: { name: 'reaper', graceMs: 50 } });
				const host = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
				const started = JSON.parse(await readyLine(host));
				/** @type {{ code: number | null; signal: string | null } | null} */
				let ended = null;
				host.once('exit', (code, signal) => {
					ended = { code, signal };
				});

				try {
					// Without a running reaper there is no handle to release, and this would pass on nothing.
					assert.equal(started.reaper.started, true, `the reaper did not start: ${started.reaper.error}`);
					assert.equal(isAlive(started.reaper.pid), true, 'the reaper was already gone before the host returned');
					await waitFor(() => ended !== null, 'the host to exit once guard() returned', {
						timeoutMs: slow(15_000),
						intervalMs: 20,
					});
					assert.deepEqual(ended, { code: 0, signal: null });
				} finally {
					stopReaper(started.reaper);
				}
			})
		)
);

test(
	'the reaper is told where a replacement host records its pid, which only its command line can carry',
	{ timeout: slow(60_000) },
	(t) => {
		if (
			skipOnWindows(
				t,
				'a Windows child dies with the host that spawned it, which test/e2e/guard.test.js measured at 65ms, ' +
					'so the process a replacement is meant to adopt is gone before the reaper looks; that the ' +
					'handover keeps it running goes uncovered there.'
			)
		)
			return;
		return withTempDir('guard-call-', (dir) =>
			withSpawn(async ({ spawn }) => {
				// The flag crosses a process boundary, so nothing in-process covers it.
				const tag = `replacement-${process.pid}`;
				const logFile = path.join(dir, 'reaper.log');
				const replacementPidFile = path.join(dir, 'replacement.pid');
				const script = writeHost(
					dir,
					{
						pidDir: dir,
						processes: [{ name: 'guarded', binaryPath: process.execPath, args: [fixture('idle.js'), tag] }],
						reaper: { name: 'reaper', graceMs: 5000, logFile, replacementPidFile },
					},
					{ park: true }
				);
				const host = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
				const started = JSON.parse(await readyLine(host));

				try {
					assert.equal(started.reaper.started, true, `the reaper did not start: ${started.reaper.error}`);
					await waitFor(
						() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf-8').includes('watching pid'),
						'the reaper to finish starting up'
					);

					// What a restart does: the replacement records its own pid, then the old host goes.
					seedLock(replacementPidFile, { pid: process.pid, argv: [] });
					host.kill('SIGKILL');

					await waitFor(
						() => fs.readFileSync(logFile, 'utf-8').includes(`pid ${process.pid} took over inside the grace window`),
						'the reaper to find the replacement it was pointed at',
						{ timeoutMs: slow(15_000), intervalMs: 50 }
					);
					assert.equal(isAlive(started.guarded), true, 'the process the replacement was to adopt was reaped');
					assert.equal(fs.existsSync(lockPath(dir, 'guarded')), true, 'the lock it would be adopted by was removed');
					await waitFor(() => !fs.existsSync(lockPath(dir, 'reaper')), 'the reaper to leave its own lock behind');
				} finally {
					// Its host is dead and the reaper deliberately left it running, so nothing else stops it.
					try {
						process.kill(started.guarded, 'SIGKILL');
					} catch {
						// Already gone, which is the outcome asked for.
					}
					stopReaper(started.reaper);
				}
			})
		);
	}
);

test(
	'the reaper waits the grace this host asked for, not the 8s its own parser falls back to',
	{ timeout: slow(60_000) },
	() =>
		withTempDir('guard-call-', (dir) =>
			withSpawn(async ({ spawn }) => {
				// slow() lifts the deadline past 8000 on Windows, which leaves this uncovered there.
				const tag = `grace-${process.pid}`;
				const logFile = path.join(dir, 'reaper.log');
				const script = writeHost(
					dir,
					{
						pidDir: dir,
						processes: [{ name: 'guarded', binaryPath: process.execPath, args: [fixture('idle.js'), tag] }],
						reaper: { name: 'reaper', graceMs: 150, logFile },
					},
					{ park: true }
				);
				const host = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
				const started = JSON.parse(await readyLine(host));

				try {
					assert.equal(started.reaper.started, true, `the reaper did not start: ${started.reaper.error}`);
					await waitFor(
						() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf-8').includes('watching pid'),
						'the reaper to finish starting up'
					);

					host.kill('SIGKILL');
					// Its own lock, since on Windows the guarded process died with its host long before this.
					await waitFor(() => !fs.existsSync(lockPath(dir, 'reaper')), 'the reaper to finish inside its grace', {
						timeoutMs: slow(4000),
						intervalMs: 50,
					});
					assert.equal(fs.existsSync(lockPath(dir, 'guarded')), false, 'the reaper finished without reaping');
				} finally {
					try {
						process.kill(started.guarded, 'SIGKILL');
					} catch {
						// Already gone, which is the outcome asked for.
					}
					stopReaper(started.reaper);
				}
			})
		)
);

test('a version that has moved makes the running process an orphan rather than something to adopt', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `upgrade-${process.pid}`;
			const before = await guard({ pidDir: dir, spawn, version: 1, processes: [declare(tag)] });
			const old = before.processes[0]?.pid;
			before.stop();

			// The same binary and command line, under a fingerprint this node no longer runs.
			const after = await guard({ pidDir: dir, spawn, version: 2, processes: [declare(tag)] });
			try {
				assert.equal(after.processes[0]?.adopted, false, 'the upgrade adopted the previous release');
				assert.notEqual(after.processes[0]?.pid, old);
				assert.match(after.report.join('\n'), /orphan of an earlier configuration \(version 1, not 2\)/);
				// Left running because stopOrphans is off, so the orphan and its replacement both count.
				assert.equal(isAlive(/** @type {number} */ (old)), true);
				await waitFor(
					() => countRunning([process.execPath, fixture('idle.js'), tag]) === 2,
					'the orphan and its replacement to both be running'
				);
				assert.equal(readLock(lockPath(dir, 'agent'))?.version, 2);
			} finally {
				after.stop();
			}
		})
	));

test('stopOrphans stops that same process, and the node is left with one', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `upgrade-stopped-${process.pid}`;
			const before = await guard({ pidDir: dir, spawn, version: 1, processes: [declare(tag)] });
			const old = before.processes[0]?.pid;
			before.stop();

			const after = await guard({ pidDir: dir, spawn, version: 2, stopOrphans: true, processes: [declare(tag)] });
			try {
				await waitFor(() => !isAlive(/** @type {number} */ (old)), 'the orphan to be stopped');
				assert.match(after.report.join('\n'), new RegExp(`pid ${old} is an orphan .* It was sent SIGTERM`));
				assert.equal(countRunning([process.execPath, fixture('idle.js'), tag]), 1);
			} finally {
				after.stop();
			}
		})
	));
