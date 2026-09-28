// @ts-check
// One winner per node. The lock is only ever REPLACED by rename, never removed then recreated: check-then-delete
// is two steps, so a second thread can delete the winner's fresh file and both believe they hold it.
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';

import { identify, IDENTIFY_BUDGET_MS, isAlive } from './identity.js';
import { errnoCode, errorMessage } from './exit.js';

/** How long a thread waits before looking again at another thread's unfinished claim, which is one file read. */
const CLAIM_POLL_MS = 2;
/** A free gate is usually a read, at most one signal and a rename away, so a waiter looks again at once. */
const GATE_RETRY_MS = 1;
// Above IDENTIFY_BUDGET_MS: adjudicate identifies inside the gate, and a writer that gave up first would
// break a gate a live thread is in.
const GATE_WAIT_MS = IDENTIFY_BUDGET_MS + 1000;
const GATE_SUFFIX = '.claiming';

/**
 * @typedef {object} Lock
 * @property {number} pid The guarded process, or 0 while the claimant has not started one yet.
 * @property {number} version Fingerprint of the configuration that started it.
 * @property {string} token The claimant's own mark; nothing may overwrite a lock carrying another's.
 * @property {number} host Pid of the process holding the claim, so a waiter can tell a dead claimant.
 * @property {readonly string[]} argv What was spawned, so a later reader can identify the pid before acting.
 */

/**
 * @typedef {{ outcome: 'won', token: string, notes: string[] }
 *   | { outcome: 'adopted', pid: number, notes: string[] }} Claim
 */

let serial = 0;

/** @param {string} pidDir @param {string} name @returns {string} */
export function lockPath(pidDir, name) {
	return join(pidDir, `${name}.pid`);
}

/** @param {string} path */
export function unlinkQuietly(path) {
	try {
		unlinkSync(path);
	} catch {
		// Absent is the outcome asked for.
	}
}

/** @param {Lock} lock @returns {string} */
function serialise(lock) {
	const record = { token: lock.token, host: lock.host, argv: lock.argv };
	return `${lock.pid}\n${lock.version}\n${JSON.stringify(record)}\n`;
}

/**
 * pid on line 1, version on line 2, so a host reading only those two still reads this. Line 3 is the guard's
 * own record, and its absence marks a lock the guard did not write.
 *
 * @param {string} path
 * @returns {Lock | null}
 */
export function readLock(path) {
	/** @type {string[]} */
	let lines;
	try {
		lines = readFileSync(path, 'utf-8').split('\n');
	} catch {
		return null;
	}
	const pid = Number.parseInt(lines[0] ?? '', 10);
	if (!Number.isInteger(pid)) return null;
	const version = Number.parseInt(lines[1] ?? '', 10);
	/** @type {Lock} */
	const lock = { pid, version: Number.isInteger(version) ? version : 0, token: '', host: 0, argv: [] };
	try {
		const record = /** @type {unknown} */ (JSON.parse(lines[2] ?? ''));
		if (typeof record !== 'object' || record === null) return lock;
		const { token, host, argv } = /** @type {{ token?: unknown; host?: unknown; argv?: unknown }} */ (record);
		if (typeof token === 'string') lock.token = token;
		if (typeof host === 'number' && Number.isInteger(host)) lock.host = host;
		if (Array.isArray(argv) && argv.every((/** @type {unknown} */ a) => typeof a === 'string')) {
			lock.argv = /** @type {string[]} */ (argv);
		}
	} catch {
		// Absent, half-written, or not this guard's. Either way, no record.
	}
	return lock;
}

/**
 * Replace the lock, signalling the orphan it names first. One function because the ORDER is the property:
 * the write erases the only record of `stop`, so a host dying between them leaves the lock naming the orphan.
 *
 * @param {string} path @param {Lock} lock @param {number} [stop] Pid to SIGTERM before the lock stops naming it.
 */
function publish(path, lock, stop) {
	if (stop !== undefined) signal(stop);
	const temp = `${path}.${lock.token}.tmp`;
	writeFileSync(temp, serialise(lock), 'utf-8');
	try {
		renameSync(temp, path);
	} catch (error) {
		// A failed rename would leave the temp in the pidDir forever, one per failed claim.
		unlinkQuietly(temp);
		throw error;
	}
}

/**
 * A lock on the lock: while held, one thread decides what happens to `path`. That exclusion turns a read
 * followed by a write into one step.
 *
 * @param {string} path @param {boolean} expired Whether the caller's whole budget has run out.
 */
function takeGate(path, expired) {
	const gate = `${path}${GATE_SUFFIX}`;
	const temp = `${gate}.${process.pid}.${threadId}.${++serial}`;
	try {
		// Written before linking, so the gate names its holder the instant it exists: one empty moment would
		// read as abandoned to whoever looked.
		writeFileSync(temp, String(process.pid), 'utf-8');
		linkSync(temp, gate);
		return true;
	} catch (error) {
		if (errnoCode(error) !== 'EEXIST') throw error;
	} finally {
		unlinkQuietly(temp);
	}

	/** @type {number | null} */
	let holder = null;
	try {
		holder = Number.parseInt(readFileSync(gate, 'utf-8'), 10);
	} catch {
		// Unreadable is "cannot tell", never "not ours": clearing on a failed read takes a gate a second
		// thread has since linked.
	}
	// A gate whose holder is dead is not a gate. `expired` breaks one deliberately, the only remaining path
	// that can leave two threads inside.
	if (expired || (holder !== null && !isAlive(holder))) unlinkQuietly(gate);
	return false;
}

/**
 * Hold the gate for `decide`, which must not await: the gate blocks every other thread's view of this lock.
 * null means it was not free.
 *
 * @template T
 * @param {string} path @param {boolean} expired @param {() => T} decide @returns {T | null}
 */
function underGate(path, expired, decide) {
	if (!takeGate(path, expired)) return null;
	try {
		return decide();
	} finally {
		unlinkQuietly(`${path}${GATE_SUFFIX}`);
	}
}

/** @param {readonly string[]} a @param {readonly string[]} b */
function sameArgv(a, b) {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** SIGTERM an identified orphan, once. @param {number} pid */
function signal(pid) {
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		// ESRCH: gone between the identification and the signal, which is the outcome asked for.
	}
}

/**
 * What to do about the lock as it stands. Reads the world and changes none of it, so every write to this
 * lock stays in the caller.
 *
 * @param {Lock | null} held
 * @param {{ name: string, version: number, argv: readonly string[], stopOrphans: boolean, expired: boolean, notes: Set<string> }} against
 * @returns {{ act: 'take', stop?: number } | { act: 'wait' } | { act: 'adopt', pid: number }}
 */
function adjudicate(held, { name, version, argv, stopOrphans, expired, notes }) {
	if (!held) return { act: 'take' };

	if (held.pid === 0) {
		// A claim another thread has not finished. Wait rather than race it; a dead claimant left one nobody
		// will complete.
		if (isAlive(held.host) && !expired) return { act: 'wait' };
		notes.add(`${name}: took over an unfinished claim from pid ${held.host}.`);
		return { act: 'take' };
	}

	if (!isAlive(held.pid)) {
		notes.add(`${name}: reclaimed the lock from pid ${held.pid}, which nothing holds.`);
		return { act: 'take' };
	}

	const running = identify(held.pid, held.argv);
	// 'unknown' is "not established", never "not ours": taking on it starts a second process for a pid that
	// is most likely the first.
	if (running === 'unknown' && !expired) return { act: 'wait' };
	if (running !== 'match') {
		notes.add(
			`${name}: the lock named live pid ${held.pid}, which ` +
				`${running === 'differs' ? 'is running something else' : 'could not be identified inside the claim budget'}. ` +
				`Taking the lock and signalling nothing.`
		);
		return { act: 'take' };
	}

	if (held.version === version && sameArgv(held.argv, argv)) {
		notes.add(`${name}: joined the running pid ${held.pid} rather than starting a second one.`);
		return { act: 'adopt', pid: held.pid };
	}

	// Ours by command line, under a configuration this node no longer runs.
	const drift =
		held.version === version
			? `a command line this node no longer uses (${held.argv.join(' ')})`
			: `version ${held.version}, not ${version}`;
	const orphan = `${name}: pid ${held.pid} is an orphan of an earlier configuration (${drift}).`;
	if (!stopOrphans) {
		notes.add(`${orphan} stopOrphans is off, so it was left running and may still hold what its replacement needs.`);
		return { act: 'take' };
	}
	// One signal, no chase: a grace period blocks startup, and by any deadline the pid may name something else.
	notes.add(
		`${orphan} It was sent SIGTERM, which nothing here waits on: until it exits it may still hold what its ` +
			`replacement needs, and nothing chases it if it ignores the signal.`
	);
	return { act: 'take', stop: held.pid };
}

/**
 * Take `<pidDir>/<name>.pid`, or join what holds it. A winner must call commitLock once it has a pid; until
 * then the lock reads pid 0 and other threads wait.
 *
 * @param {object} options
 * @param {string} options.pidDir
 * @param {string} options.name Lock filename stem, and how the notes name this process.
 * @param {number} options.version
 * @param {readonly string[]} options.argv What this node would spawn; also what identifies the pid later.
 * @param {number} [options.timeoutMs] How long to wait on another thread's unfinished claim.
 * @param {boolean} [options.stopOrphans] Whether an identified orphan may be signalled. Off by default.
 * @returns {Promise<Claim>}
 */
export async function claimLock({ pidDir, name, version, argv, timeoutMs = 30_000, stopOrphans = false }) {
	mkdirSync(pidDir, { recursive: true });
	const path = lockPath(pidDir, name);
	const token = `${process.pid}.${threadId}.${++serial}.${Date.now().toString(36)}`;
	// A set: a thread looping around the gate re-adjudicates and would say the same thing twice.
	/** @type {Set<string>} */
	const notes = new Set();
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const expired = Date.now() >= deadline;
		const verdict = underGate(path, expired, () => {
			const decision = adjudicate(readLock(path), { name, version, argv, stopOrphans, expired, notes });
			if (decision.act !== 'take') return decision;
			// Inside the gate, so no sibling reads a dying pid and adopts a corpse. publish signals itself,
			// which keeps that ahead of the write erasing the pid.
			publish(path, { pid: 0, version, token, host: process.pid, argv }, decision.stop);
			return decision;
		});

		if (verdict === null) await delay(GATE_RETRY_MS);
		else if (verdict.act === 'take') return { outcome: 'won', token, notes: [...notes] };
		else if (verdict.act === 'adopt') return { outcome: 'adopted', pid: verdict.pid, notes: [...notes] };
		else await delay(CLAIM_POLL_MS);
	}
}

/** What a gated write did: wrote it, found the lock absent, or found another token holding it. */
/** @typedef {'written' | 'gone' | 'taken'} WriteOutcome */

/**
 * Record the pid this claim started, while the lock is still ours: a claimant taken over must not stamp its
 * pid onto the winner's file.
 *
 * @param {string} path @param {string} token @param {number} pid @param {number} version @param {readonly string[]} argv
 * @returns {Promise<WriteOutcome>}
 */
export function commitLock(path, token, pid, version, argv) {
	return writeUnderGate(path, (held) => {
		if (held === null) return 'gone';
		if (held.token !== token) return 'taken';
		publish(path, { pid, version, token, host: process.pid, argv });
		return 'written';
	});
}

/**
 * Remove the lock while it is still ours. The one place a lock is removed rather than replaced: its process
 * was shut down on purpose and nothing should adopt it.
 *
 * @param {string} path @param {string} token @returns {Promise<WriteOutcome>}
 */
export function releaseLock(path, token) {
	return writeUnderGate(path, (held) => {
		if (held === null) return 'gone';
		if (held.token !== token) return 'taken';
		unlinkQuietly(path);
		return 'written';
	});
}

/**
 * Await a lock write that must not throw: every caller sits behind a fire-and-forget death handler or a catch
 * already reporting something else. A non-'written' outcome is as much a failure, and says which.
 *
 * @param {Promise<WriteOutcome>} write @returns {Promise<string | undefined>} The failure message, or undefined.
 */
export async function safeLockWrite(write) {
	try {
		const outcome = await write;
		if (outcome === 'written') return undefined;
		// Only one is a handover: an absent lock was removed by the reaper or a sibling's release, and calling
		// that a handover invents a thread nobody has.
		return outcome === 'gone'
			? 'the lock was already gone when this write landed'
			: 'the lock changed hands before this write landed';
	} catch (error) {
		return errorMessage(error);
	}
}

/** @param {string} path @param {(held: Lock | null) => WriteOutcome} write @returns {Promise<WriteOutcome>} */
async function writeUnderGate(path, write) {
	// A gate is held across an identification at worst, so wait that out. The budget matters only for a
	// thread that died mid-decision.
	const deadline = Date.now() + GATE_WAIT_MS;
	for (;;) {
		const done = underGate(path, Date.now() >= deadline, () => write(readLock(path)));
		if (done !== null) return done;
		await delay(GATE_RETRY_MS);
	}
}
