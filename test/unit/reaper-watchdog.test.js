// A node whose reaper died has nothing to stop its orphans, so keepReaperAlive watches the lock and asks the
// guard for the reaper half on its own when it finds none.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { keepReaperAlive } from '../../src/index.js';

const REAPER = 'datadog-agent-reaper';
const DEAD_PID = 2 ** 22 - 7;
const quiet = { info() {}, warn() {}, error() {} };
/** The timer is never wanted in a test: every tick here is driven by hand. */
const noTimer = () => ({ unref() {} });

describe('keeping a reaper on the node', () => {
	/** @type {string} */ let dir;
	/** @type {import('node:child_process').ChildProcess} */ let child;
	/** @type {string[]} */ let childArgv;

	const lock = (/** @type {number} */ pid) =>
		writeFileSync(join(dir, `${REAPER}.pid`), `${pid}\n7\n${JSON.stringify({ token: 't', host: 1, argv: childArgv })}`);

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'dd-reaper-watch-'));
		childArgv = [process.execPath, '-e', 'setInterval(function () {}, 1000)'];
		child = spawn(/** @type {string} */ (childArgv[0]), childArgv.slice(1), { stdio: 'ignore' });
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				lock(/** @type {number} */ (child.pid));
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 25));
			}
		}
	});

	after(() => {
		child?.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	});

	const watcher = (
		/** @type {() => Promise<any>} */ relaunch,
		/** @type {import('../../src/host.js').Log} */ log = quiet
	) =>
		keepReaperAlive({
			pidDir: dir,
			reaper: { name: REAPER, started: true },
			relaunch,
			log,
			setTimer: noTimer,
		});

	it('NEGATIVE: does not relaunch a reaper that is still there', async () => {
		lock(/** @type {number} */ (child.pid));
		let called = 0;
		const w = watcher(async () => called++);
		assert.equal(await w.tick(), 'present');
		assert.equal(called, 0, 'a healthy node must never be asked to spawn');
		w.stop();
	});

	it('relaunches when the lock names a pid nothing holds', async () => {
		lock(DEAD_PID);
		let called = 0;
		const w = watcher(async () => {
			called++;
			lock(/** @type {number} */ (child.pid)); // what a successful relaunch leaves behind
		});
		assert.equal(await w.tick(), 'relaunched');
		assert.equal(called, 1);
		// And having recovered, it stops asking.
		assert.equal(await w.tick(), 'present');
		assert.equal(called, 1);
		w.stop();
	});

	it('backs off when a relaunch leaves no reaper, rather than spawning every minute', async () => {
		lock(DEAD_PID);
		/** @type {string[]} */
		const lines = [];
		const w = watcher(async () => {}, {
			info() {},
			warn() {},
			error: (/** @type {string} */ line) => void lines.push(line),
		});
		assert.equal(await w.tick(), 'failed');
		assert.equal(await w.tick(), 'backoff', 'the next tick must not spawn again immediately');
		assert.match(/** @type {string} */ (lines[0]), /left none running/);
		assert.match(/** @type {string} */ (lines[0]), /next attempt in/);
		w.stop();
	});

	it('treats a throwing relaunch as a failure and says so', async () => {
		lock(DEAD_PID);
		/** @type {string[]} */
		const lines = [];
		const w = watcher(
			async () => {
				throw new Error('spawn EACCES');
			},
			{ info() {}, warn() {}, error: (/** @type {string} */ line) => void lines.push(line) }
		);
		assert.equal(await w.tick(), 'failed');
		assert.match(/** @type {string} */ (lines[0]), /EACCES/);
		w.stop();
	});

	it('NEGATIVE: does not start a second relaunch while one is still running', async () => {
		lock(DEAD_PID);
		let inFlight = 0;
		let peak = 0;
		const w = watcher(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 40));
			inFlight--;
			lock(/** @type {number} */ (child.pid));
		});
		const [first, second] = await Promise.all([w.tick(), w.tick()]);
		assert.equal(peak, 1, "two threads' worth of spawning is what the lock exists to prevent");
		assert.equal(first, 'relaunched');
		assert.equal(second, 'present');
		w.stop();
	});
});
