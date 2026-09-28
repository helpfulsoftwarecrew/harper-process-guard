// A reaper the guard started can die, so the status reads it off the lock rather than the boot state.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { currentReaper, heldProcess } from '../../src/index.js';

const REAPER = 'datadog-agent-reaper';
// A pid nothing holds. 2^22 is above every default pid_max, so this cannot race a real process.
const DEAD_PID = 2 ** 22 - 7;

/** The three-line shape the guard writes: pid, version, then the record carrying the argv. */
const lock = (/** @type {string} */ dir, /** @type {number} */ pid, /** @type {string[]} */ argv, version = 7) =>
	writeFileSync(join(dir, `${REAPER}.pid`), `${pid}\n${version}\n${JSON.stringify({ token: 't', host: 1, argv })}`);

const bootState = { name: REAPER, started: true, adopted: false, pid: 888 };

describe('the reaper in the status', () => {
	/** @type {string} */ let dir;
	/** @type {import('node:child_process').ChildProcess} */ let child;
	/** @type {string[]} */ let childArgv;

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'dd-reaper-status-'));
		childArgv = [process.execPath, '-e', 'setInterval(function () {}, 1000)'];
		child = spawn(/** @type {string} */ (childArgv[0]), childArgv.slice(1), { stdio: 'ignore' });
		// ps and /proc only report the process once the exec has happened.
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (currentReaper(bootState, dir) !== undefined) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	});

	after(() => {
		child?.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	});

	it('reports a reaper whose lock still identifies it, under the pid the lock names', () => {
		lock(dir, /** @type {number} */ (child.pid), childArgv);
		const now = /** @type {any} */ (currentReaper(bootState, dir));
		assert.equal(now.started, true);
		// The lock's pid, not the boot state's: another thread may have replaced the reaper this one started.
		assert.equal(now.pid, child.pid);
	});

	it('NEGATIVE: refuses to call a reaper started when its lock names a pid nothing holds', () => {
		lock(dir, DEAD_PID, childArgv);
		const now = /** @type {any} */ (currentReaper(bootState, dir));
		assert.equal(now.started, false, 'a dead reaper must not be reported as started');
		assert.equal(now.pid, undefined, "the dead pid must not be published as the reaper's");
		assert.match(now.error, /nothing holds/);
		assert.match(now.error, /outlive it/);
	});

	it('NEGATIVE: refuses a live pid running something else', () => {
		lock(dir, /** @type {number} */ (child.pid), ['/nonexistent/reaper.js', '--host-pid', '1']);
		const now = /** @type {any} */ (currentReaper(bootState, dir));
		assert.equal(now.started, false);
		assert.match(now.error, /running something else/);
	});

	it('NEGATIVE: refuses when there is no lock at all', () => {
		const empty = mkdtempSync(join(tmpdir(), 'dd-reaper-empty-'));
		try {
			const now = /** @type {any} */ (currentReaper(bootState, empty));
			assert.equal(now.started, false);
			assert.match(now.error, /no lock for/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it('keeps the boot state when no reaper was configured, and when the pid directory is unknown', () => {
		assert.equal(currentReaper(undefined, dir), undefined);
		assert.deepEqual(currentReaper(bootState, undefined), bootState);
	});

	describe('heldProcess', () => {
		it('reads the pid, the version and the recorded argv', () => {
			lock(dir, 4242, ['node', 'reaper.js'], 9);
			const held = heldProcess(join(dir, `${REAPER}.pid`));
			// The whole lock in readLock's own shape, not a three-field copy of it.
			assert.equal(held?.pid, 4242);
			assert.equal(held?.version, 9);
			assert.deepEqual(held?.argv, ['node', 'reaper.js']);
		});

		// pid 0 is the claim-in-flight sentinel, written before a winner records its process. It identifies
		// against nothing, so a lock naming it is not a lock naming a process.
		it('NEGATIVE: a lock mid-claim names no process', () => {
			writeFileSync(join(dir, `${REAPER}.pid`), '0\n1\n');
			assert.equal(heldProcess(join(dir, `${REAPER}.pid`)), undefined);
		});

		it('identifies nothing for a lock written before the argv record, rather than throwing', () => {
			writeFileSync(join(dir, `${REAPER}.pid`), '4242\n9');
			assert.deepEqual(heldProcess(join(dir, `${REAPER}.pid`))?.argv, []);
		});

		it('treats an unreadable or pidless lock as no lock', () => {
			assert.equal(heldProcess(join(dir, 'absent.pid')), undefined);
			writeFileSync(join(dir, `${REAPER}.pid`), 'not a pid\n9\n[]');
			assert.equal(heldProcess(join(dir, `${REAPER}.pid`)), undefined);
		});
	});
});
