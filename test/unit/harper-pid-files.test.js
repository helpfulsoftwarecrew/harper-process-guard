// Harper's spawn hands back the pid in <root>/pids/<name>.pid whenever kill(pid, 0) answers, and after a
// restart a thread of Harper itself can answer, so the file has to go before the guard asks for a spawn.

import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { argvOf, isAlive } from '../../src/identity.js';
import { clearStaleHostPidFiles, REAPER_WATCH_MS, supervisorFor } from '../../src/index.js';
import { lockPath, readLock } from '../../src/lock.js';
import { runsScript } from '../../src/node.js';
import { KEEPER_SCRIPT, pidOf, skipOnWindows, waitFor, withSpawn, withZombie } from '../support/harness.js';
import { withTempDir } from '../support/sandbox.js';
import { captureLogs } from '../support/sandbox.js';

const NO_ZOMBIE = 'Windows leaves no zombie for a pid file to name.';

const pidFile = (/** @type {string} */ root, /** @type {string} */ name) => path.join(root, 'pids', `${name}.pid`);
const write = (/** @type {string} */ root, /** @type {string} */ name, /** @type {number} */ pid) => {
	fs.mkdirSync(path.join(root, 'pids'), { recursive: true });
	fs.writeFileSync(pidFile(root, name), `${pid}\n`);
};
const silent = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Harper's constrained spawn as security/jsLoader.ts has it at v5.2.9: a bare `node` only, and a live pid in
 * `<root>/pids/<name>.pid` handed back in place of a spawn. @param {string} root @param {any} spawn
 */
const harperSpawn =
	(root, spawn) => (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
		if (command !== 'node') throw new Error(`Command ${command} is not allowed`);
		const file = pidFile(root, options.name);
		try {
			const pid = Number.parseInt(fs.readFileSync(file, 'utf-8'), 10);
			process.kill(pid, 0);
			return Object.assign(new EventEmitter(), { pid, unref: () => {} });
		} catch {}
		// A bare `node` from PATH runs as `node`, which is the command line the lock records and identifies by.
		const child = spawn(process.execPath, args, { ...options, argv0: 'node' });
		write(root, options.name, child.pid);
		return child;
	};

test('NEGATIVE: a Harper pid file naming a live pid that is not the agent is removed, and the log says what it was running', () =>
	withTempDir('dd-hpid-', async (root) => {
		// This process is alive and is running node, not a trace-agent.
		write(root, 'datadog-trace-agent', process.pid);
		const lines = await captureLogs(() =>
			clearStaleHostPidFiles(
				root,
				[
					{
						name: 'datadog-trace-agent',
						argv: ['/opt/dd/bin/trace-agent', 'run'],
					},
				],
				console
			)
		);
		assert.equal(fs.existsSync(pidFile(root, 'datadog-trace-agent')), false, 'the stale file survived');
		const line = lines.find((entry) => entry.includes('removed'));
		assert.ok(line, 'nothing was logged about the removal');
		assert.match(line, new RegExp(`named pid ${process.pid}, which is running`));
	}));

test("a Harper pid file naming the real process is Harper's to keep, and one naming a dead pid too", () =>
	withTempDir('dd-hpid-', async (root) => {
		// Matching argv: this process, under its own command line, is "the agent" for this test.
		write(root, 'datadog-agent', process.pid);
		write(root, 'datadog-agent-reaper', 2 ** 22 - 7);
		const lines = await captureLogs(() =>
			clearStaleHostPidFiles(
				root,
				[
					{ name: 'datadog-agent', argv: [/** @type {string} */ (process.argv[0])] },
					{ name: 'datadog-agent-reaper', script: '/reaper.js' },
				],
				console
			)
		);
		assert.equal(fs.existsSync(pidFile(root, 'datadog-agent')), true, "the real process's file was removed");
		assert.equal(
			fs.existsSync(pidFile(root, 'datadog-agent-reaper')),
			true,
			"a dead pid's file was removed; Harper clears those itself"
		);
		assert.deepEqual(lines, []);
	}));

/** A node process whose command line reads as the keeper or launcher for `lock`. @param {any} spawn @param {string} mode @param {string} lock */
const keeperStandIn = async (spawn, mode, lock) => {
	const standIn = spawn(
		process.execPath,
		['-e', 'setInterval(() => {}, 1 << 30)', KEEPER_SCRIPT, mode, '--lock', lock, '--token', 'stand-in'],
		{ stdio: 'ignore' }
	);
	await waitFor(() => argvOf(pidOf(standIn)) !== null, 'the stand-in to appear in the process table');
	return standIn;
};

test("a Harper pid file naming a keeper's launcher is the guard's own for that moment, and stays", () =>
	withTempDir('dd-hpid-', (root) =>
		withSpawn(async ({ spawn }) => {
			// Harper records the launcher under the process's name until the launcher exits, a moment later.
			const lock = path.join(root, 'locks', 'datadog-agent.pid');
			const standIn = await keeperStandIn(spawn, '--launch', lock);
			write(root, 'datadog-agent', pidOf(standIn));
			const lines = await captureLogs(() =>
				clearStaleHostPidFiles(root, [{ name: 'datadog-agent', argv: ['/opt/dd/bin/agent', 'run'], lock }], console)
			);
			assert.equal(fs.existsSync(pidFile(root, 'datadog-agent')), true, "the launcher's file was removed");
			assert.deepEqual(lines, []);
		})
	));

test("NEGATIVE: a Harper pid file naming another name's keeper is removed, the reaper's and a process's alike", () =>
	withTempDir('dd-hpid-', (root) =>
		withSpawn(async ({ spawn }) => {
			// A restart let the agent's keeper take the pid Harper had recorded for the reaper and the trace agent.
			const locks = path.join(root, 'locks');
			const standIn = await keeperStandIn(spawn, '--keep', path.join(locks, 'datadog-agent.pid'));
			write(root, 'datadog-agent-reaper', pidOf(standIn));
			write(root, 'datadog-trace-agent', pidOf(standIn));
			const lines = await captureLogs(() =>
				clearStaleHostPidFiles(
					root,
					[
						{ name: 'datadog-agent-reaper', script: '/reaper.js', lock: path.join(locks, 'datadog-agent-reaper.pid') },
						{
							name: 'datadog-trace-agent',
							argv: ['/opt/dd/bin/trace-agent', 'run'],
							lock: path.join(locks, 'datadog-trace-agent.pid'),
						},
					],
					console
				)
			);
			assert.equal(fs.existsSync(pidFile(root, 'datadog-agent-reaper')), false, "the reaper's file survived");
			assert.equal(fs.existsSync(pidFile(root, 'datadog-trace-agent')), false, "the trace agent's file survived");
			assert.equal(lines.filter((line) => line.includes('removed')).length, 2);
		})
	));

test("NEGATIVE: a reaper whose Harper pid file names another name's keeper is started, not refused as handed back", () =>
	withTempDir('dd-hpid-', (root) =>
		withSpawn(async ({ spawn, children }) => {
			const pidDir = path.join(root, 'locks');
			fs.mkdirSync(pidDir, { recursive: true });
			// What the soak's leg had: the reaper once ran as a pid that an agent's keeper held after a restart.
			const standIn = await keeperStandIn(spawn, '--keep', path.join(pidDir, 'datadog-agent.pid'));
			write(root, 'datadog-agent-reaper', pidOf(standIn));
			const supervisor = supervisorFor(
				{},
				{ log: silent, spawn: harperSpawn(root, spawn), reaperName: 'datadog-agent-reaper' }
			);
			const result = await supervisor.start([], { root, pidDir, fingerprintParts: ['pid-reuse'] });
			const reaper = /** @type {any} */ (result.reaper);
			try {
				assert.equal(reaper?.started, true, `the reaper did not start: ${reaper?.error}`);
				assert.notEqual(reaper.pid, pidOf(standIn), "the keeper's pid was taken for the reaper");
				assert.ok(argvOf(reaper.pid)?.join(' ').includes('reaper.js'), 'the reaper pid is not running reaper.js');
				assert.equal(Number(fs.readFileSync(pidFile(root, 'datadog-agent-reaper'), 'utf-8')), reaper.pid);
			} finally {
				for (const child of children) if (child.pid) child.kill('SIGKILL');
			}
		})
	));

/**
 * The bundled supervisor started through Harper's spawn with its reaper up, and the watchdog's tick in hand rather
 * than on its 60 s timer. `lines` gathers what the watchdog warns and errors.
 *
 * @param {string} root @param {any} spawn @param {string} name The reaper's lock name.
 */
async function reaperUnderWatchdog(root, spawn, name) {
	const pidDir = path.join(root, 'locks');
	fs.mkdirSync(pidDir, { recursive: true });
	/** @type {string[]} */
	const lines = [];
	const keep = (/** @type {string} */ line) => void lines.push(line);
	const log = { info: () => {}, warn: keep, error: keep };
	const supervisor = supervisorFor({}, { log, spawn: harperSpawn(root, spawn), reaperName: name });
	/** @type {(() => void)[]} */
	const ticks = [];
	const realSetInterval = globalThis.setInterval;
	globalThis.setInterval = /** @type {any} */ (
		(/** @type {() => void} */ fn, /** @type {number} */ ms) => {
			if (ms !== REAPER_WATCH_MS) return realSetInterval(fn, ms);
			ticks.push(fn);
			return { unref() {} };
		}
	);
	const result = await supervisor.start([], { root, pidDir, fingerprintParts: ['relaunch'] }).finally(() => {
		globalThis.setInterval = realSetInterval;
	});
	const first = /** @type {any} */ (result.reaper);
	assert.equal(first?.started, true, `the reaper did not start: ${first?.error}`);
	const tick = ticks[0];
	assert.ok(tick && ticks.length === 1, `the bundled supervisor set ${ticks.length} watchdogs, not one`);
	return { pidDir, lines, first, tick };
}

test("NEGATIVE: the watchdog's relaunch clears a dead reaper's Harper pid file that another name's keeper now holds", () =>
	withTempDir('dd-hpid-', (root) =>
		withSpawn(async ({ spawn }) => {
			const name = 'datadog-agent-reaper';
			const { pidDir, lines, first, tick } = await reaperUnderWatchdog(root, spawn, name);

			// The reaper dies, and a keeper of another name takes the pid Harper's file still names.
			process.kill(first.pid, 'SIGKILL');
			await waitFor(() => !isAlive(first.pid), 'the reaper to die');
			const standIn = await keeperStandIn(spawn, '--keep', path.join(pidDir, 'datadog-agent.pid'));
			write(root, name, pidOf(standIn));

			tick();
			await waitFor(
				() => lines.some((line) => /relaunch/.test(line)),
				'the watchdog to relaunch the reaper or say why not'
			);
			assert.match(lines.join('\n'), /has been relaunched as pid/, lines.join('\n'));
			const relaunched = readLock(lockPath(pidDir, name))?.pid ?? 0;
			assert.notEqual(relaunched, pidOf(standIn), "the keeper's pid was taken for the reaper");
			assert.ok(argvOf(relaunched)?.join(' ').includes('reaper.js'), 'the relaunched pid is not running reaper.js');
			assert.equal(Number(fs.readFileSync(pidFile(root, name), 'utf-8')), relaunched);
		})
	));

// A reaper killed after the worker thread that spawned it had ended: no thread is left to reap it, and Harper's
// kill(pid, 0) reads the zombie as running, so every relaunch was handed the zombie back (pack hour, 2026-09-30).
test("NEGATIVE: the watchdog's relaunch starts a reaper when Harper's pid file names the dead reaper as a zombie", (t) => {
	if (skipOnWindows(t, NO_ZOMBIE)) return;
	return withTempDir('dd-hpid-', (root) =>
		withSpawn(async ({ spawn }) =>
			withZombie(async (zombie) => {
				const name = 'datadog-agent-reaper';
				const { pidDir, lines, first, tick } = await reaperUnderWatchdog(root, spawn, name);
				process.kill(first.pid, 'SIGKILL');
				await waitFor(() => !isAlive(first.pid), 'the reaper to die');
				// Its lock and Harper's file name it still, and it has not been reaped.
				const lock = lockPath(pidDir, name);
				fs.writeFileSync(lock, fs.readFileSync(lock, 'utf-8').replace(/^\d+/, String(zombie)));
				write(root, name, zombie);

				tick();
				await waitFor(
					() => lines.some((line) => /relaunch/.test(line)),
					'the watchdog to relaunch the reaper or say why not'
				);
				assert.match(lines.join('\n'), /has been relaunched as pid/, lines.join('\n'));
				const relaunched = readLock(lock)?.pid ?? 0;
				assert.notEqual(relaunched, zombie, 'the zombie Harper handed back was taken for the reaper');
				assert.ok(argvOf(relaunched)?.join(' ').includes('reaper.js'), 'the relaunched pid is not running reaper.js');
			})
		)
	);
});

test("NEGATIVE: a Harper pid file naming a zombie is removed, since Harper's check reads a zombie as running", (t) => {
	if (skipOnWindows(t, NO_ZOMBIE)) return;
	return withTempDir('dd-hpid-', (root) =>
		withZombie(async (zombie) => {
			write(root, 'datadog-agent-reaper', zombie);
			write(root, 'datadog-trace-agent', zombie);
			const lines = await captureLogs(() =>
				clearStaleHostPidFiles(
					root,
					[
						{
							name: 'datadog-agent-reaper',
							script: '/reaper.js',
							lock: path.join(root, 'locks', 'datadog-agent-reaper.pid'),
						},
						{ name: 'datadog-trace-agent', argv: ['/opt/dd/bin/trace-agent', 'run'] },
					],
					console
				)
			);
			assert.equal(fs.existsSync(pidFile(root, 'datadog-agent-reaper')), false, "the reaper's file survived");
			assert.equal(fs.existsSync(pidFile(root, 'datadog-trace-agent')), false, "the trace agent's file survived");
			const said = lines.filter((line) => line.includes(`named pid ${zombie}, which has exited and was never reaped`));
			assert.equal(said.length, 2, lines.join('\n'));
		})
	);
});

test('a reaper file naming a live pid that is not running reaper.js is removed', () =>
	withTempDir('dd-hpid-', async (root) => {
		write(root, 'datadog-agent-reaper', process.pid);
		const lines = await captureLogs(() =>
			clearStaleHostPidFiles(root, [{ name: 'datadog-agent-reaper', script: '/reaper.js' }], console)
		);
		assert.equal(fs.existsSync(pidFile(root, 'datadog-agent-reaper')), false);
		assert.equal(lines.length, 1);
	}));

test("a reaper file naming this name's reaper stays, and one naming another name's reaper is removed", () =>
	withTempDir('dd-hpid-', (root) =>
		withSpawn(async ({ spawn }) => {
			const locks = path.join(root, 'locks');
			const reaperOf = async (/** @type {string} */ name) => {
				const lock = path.join(locks, `${name}.pid`);
				// This platform's separators, so a Windows leg reads the backslashed path a real reaper runs under.
				const script = path.join(root, 'src', 'reaper.js');
				const args = ['-e', 'setInterval(() => {}, 1 << 30)', script, '--self-lock', lock];
				const standIn = spawn(process.execPath, args, { stdio: 'ignore' });
				await waitFor(() => argvOf(pidOf(standIn)) !== null, 'the stand-in to appear in the process table');
				write(root, name, pidOf(standIn));
				return lock;
			};
			const own = await reaperOf('datadog-agent-reaper');
			await reaperOf('other-reaper');
			// The other component's file, asked about under this component's lock, as a pid reused across names would be.
			const lines = await captureLogs(() =>
				clearStaleHostPidFiles(
					root,
					[
						{ name: 'datadog-agent-reaper', script: '/reaper.js', lock: own },
						{ name: 'other-reaper', script: '/reaper.js', lock: own },
					],
					console
				)
			);
			assert.equal(fs.existsSync(pidFile(root, 'datadog-agent-reaper')), true, "this name's reaper lost its file");
			assert.equal(fs.existsSync(pidFile(root, 'other-reaper')), false, "another name's reaper kept the file");
			assert.equal(lines.length, 1);
		})
	));

test("NEGATIVE: a reaper's win32 command line, one line of backslashed paths, is this name's reaper and no other's", () => {
	// The shape CIM reports for a reaper the bundled supervisor started on a Windows runner.
	const locks = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\dd-hpid-a1b2c3\\locks';
	const own = `${locks}\\datadog-agent-reaper.pid`;
	const line = (/** @type {string} */ selfLock) => [
		'C:\\hostedtoolcache\\windows\\node\\24.11.0\\x64\\node.exe ' +
			'D:\\a\\app\\node_modules\\@helpfulsoftwarecrew\\harper-process-guard\\src\\reaper.js ' +
			`--host-pid 4242 --pid-dir ${locks} --grace-ms 8000 --self-lock ${selfLock}`,
	];
	assert.equal(runsScript(line(own), '/reaper.js', '--self-lock', own), true, "this name's reaper was not recognised");
	const other = `${locks}\\other-reaper.pid`;
	assert.equal(runsScript(line(other), '/reaper.js', '--self-lock', own), false, "another name's reaper was taken");
	const keeper = [`C:\\node.exe D:\\a\\app\\src\\keeper.js --keep --lock ${own} --token t -- C:\\agent.exe`];
	assert.equal(runsScript(keeper, '/reaper.js', '--self-lock', own), false, 'a keeper was taken for the reaper');
});

test('no root, nothing to clear', async () => {
	const lines = await captureLogs(() => clearStaleHostPidFiles(null, [{ name: 'x', argv: ['y'] }], console));
	assert.deepEqual(lines, []);
});
