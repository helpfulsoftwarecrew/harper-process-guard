// @ts-check
// A detached process, because nothing inside the host survives its death: there is no worker shutdown
// hook, and SIGKILL fires no handler. Spawned by path, never imported.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { identifyKept, isAlive, STOP_POLL_MS, waitWhileAlive } from './identity.js';
import { errorMessage } from './exit.js';
import { commitLock, readLock, releaseOwnLock, removeLock } from './lock.js';

const DEFAULT_WATCH_POLL_MS = 1000;
const DEFAULT_TERM_GRACE_MS = 5000;

/** First argument of a launcher: start the reaper, commit its pid under `--token`, and exit. */
export const LAUNCH_FLAG = '--launch';

/**
 * @typedef {object} ReaperOptions
 * @property {number} hostPid The process to watch. When it goes, the guarded processes are stopped.
 * @property {string} pidDir Where the locks live; every lock this guard wrote is a target.
 * @property {number} graceMs How long to wait for a replacement host before reaping.
 * @property {string} [replacementPidFile] Where a replacement host records its pid; a restart forks a new one, and its processes are kept for it to adopt.
 * @property {string} [selfLock] This reaper's own lock, removed on the way out so a replacement can take one.
 * @property {string} [logFile]
 * @property {number} [termGraceMs] How long a process gets after SIGTERM before SIGKILL.
 * @property {number} [watchPollMs] How often the host is checked.
 */

/** @param {ReaperOptions} options @param {string} message */
function log(options, message) {
	if (!options.logFile) return;
	try {
		const fd = openSync(options.logFile, 'a');
		try {
			writeSync(fd, `${new Date().toISOString()} [reaper ${process.pid}] ${message}\n`);
		} finally {
			// Closed by hand rather than left to exit: this process is killed, not returned from.
			closeSync(fd);
		}
	} catch {
		// A log that cannot be written must not stop the reaping, which is the job.
	}
}

/**
 * Every lock this guard wrote under `pidDir`, its own excluded: one with no guard record on line 3 belongs
 * to the host, and nothing here may act on it.
 *
 * @param {ReaperOptions} options
 * @returns {{ path: string; pid: number; argv: readonly string[] }[]}
 */
export function collectTargets(options) {
	/** @type {string[]} */
	let entries;
	try {
		entries = readdirSync(options.pidDir);
	} catch {
		return [];
	}
	const targets = [];
	for (const entry of entries) {
		if (!entry.endsWith('.pid')) continue;
		const path = join(options.pidDir, entry);
		if (path === options.selfLock) continue;
		const lock = readLock(path);
		if (!lock || lock.token === '' || lock.argv.length === 0) continue;
		targets.push({ path, pid: lock.pid, argv: lock.argv });
	}
	return targets;
}

/** A target this reaper has sent SIGTERM and removed the lock of, until it is seen gone or killed. @type {import('./lock.js').Lock | null} */
let signalled = null;

/**
 * The lock goes BEFORE the signal: a thread reading a dying pid adopts a corpse and never retries, where
 * one finding nothing starts a replacement.
 *
 * @param {ReaperOptions} options @param {{ path: string; pid: number; argv: readonly string[] }} target
 */
export async function reapTarget(options, target) {
	// Read again inside the gate, since a keeper may have committed a restart since collectTargets read it.
	// A pid of 0 identifies as 'differs' rather than reaching kill(2), where it would name a process GROUP.
	const removed = await removeLock(target.path, (held) =>
		identifyKept(held.pid, held.argv, held.keeper, held.keeperArgv ?? [], held.started)
	);
	if (removed.held === null) {
		log(options, `${target.path}: already gone`);
		return;
	}
	const { pid } = removed.held;
	if (removed.decision !== 'match') {
		log(options, `${target.path}: pid ${pid} is not that process (${removed.decision}); left alone`);
		return;
	}

	try {
		process.kill(pid, 'SIGTERM');
		signalled = removed.held;
		log(options, `sent SIGTERM to ${pid} (${target.path})`);
	} catch (error) {
		log(options, `could not SIGTERM ${pid}: ${errorMessage(error)}`);
		return;
	}

	const grace = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
	await waitWhileAlive(pid, Date.now() + grace, STOP_POLL_MS);
	signalled = null;
	if (!isAlive(pid)) return;

	// SIGKILL reaches only a pid identified above; signalling an unnamed one would be this module's own defect.
	try {
		process.kill(pid, 'SIGKILL');
		log(options, `${pid} ignored SIGTERM for ${grace}ms; sent SIGKILL`);
	} catch (error) {
		log(options, `could not SIGKILL ${pid}: ${errorMessage(error)}`);
	}
}

/** The pid of a replacement host, or null. Never the watched process: the OS can hand that pid to a
 * stranger inside the grace window, and adopting it orphans everything for good.
 * @param {ReaperOptions} options */
export function replacementPid(options) {
	if (!options.replacementPidFile) return null;
	const lock = readLock(options.replacementPidFile);
	if (lock === null || lock.pid === options.hostPid || !isAlive(lock.pid)) return null;
	return lock.pid;
}

/**
 * This reaper's own lock, removed only while it names this reaper: a host that replaced this one's took the lock for
 * its own reaper, and removing that left the node reporting none while one ran. @param {ReaperOptions} options
 */
async function releaseSelf(options) {
	if (!options.selfLock) return;
	try {
		const released = await releaseOwnLock(options.selfLock, process.pid);
		if (released.outcome === 'taken') log(options, `its lock now names pid ${released.pid}; left it to that reaper`);
	} catch (error) {
		log(options, `could not release its own lock: ${errorMessage(error)}`);
	}
}

/** Exported so a test can drive it without spawning one. @param {ReaperOptions} options */
export async function run(options) {
	log(options, `watching pid ${options.hostPid}; will stop what is locked under ${options.pidDir} when it goes.`);
	await waitWhileAlive(options.hostPid, Infinity, options.watchPollMs ?? DEFAULT_WATCH_POLL_MS);
	log(options, `pid ${options.hostPid} is gone`);

	// A restart forks a replacement and exits the old host, so the processes are kept for it to adopt
	// rather than stopped and started again.
	const deadline = Date.now() + options.graceMs;
	while (Date.now() < deadline) {
		const replacement = replacementPid(options);
		if (replacement !== null) {
			log(options, `pid ${replacement} took over inside the grace window; leaving the processes for it`);
			await releaseSelf(options);
			return;
		}
		await delay(100);
	}

	// Enumerated now rather than at launch: a thread that joined this reaper later left its lock here too.
	for (const target of collectTargets(options)) await reapTarget(options, target);
	await releaseSelf(options);
	log(options, 'done.');
}

/** @param {string[]} argv @returns {ReaperOptions} */
export function parseArgs(argv) {
	/** @type {ReaperOptions} */
	const options = { hostPid: Number.NaN, pidDir: '', graceMs: 8000 };
	for (let i = 0; i < argv.length; i += 2) {
		// Every flag takes a value, so one arriving as the final token has nothing to consume.
		const value = argv[i + 1];
		if (value === undefined) break;
		switch (argv[i]) {
			case '--host-pid':
				options.hostPid = Number.parseInt(value, 10);
				break;
			case '--pid-dir':
				options.pidDir = value;
				break;
			case '--grace-ms':
				options.graceMs = Number.parseInt(value, 10);
				break;
			case '--replacement-pid-file':
				options.replacementPidFile = value;
				break;
			case '--self-lock':
				options.selfLock = value;
				break;
			case '--log':
				options.logFile = value;
				break;
		}
	}
	return options;
}

/**
 * Handled so the stop is logged rather than silent. The lock is left naming this pid, which the next claim reclaims:
 * whoever stops a reaper may be removing its directory, and a release through the gate wrote into it mid-removal.
 *
 * @param {ReaperOptions} options @param {NodeJS.Signals} signal
 */
function stopOnSignal(options, signal) {
	// A target already sent SIGTERM has no lock left, so one that ignores it would run on beside the next claim's copy.
	const target = signalled;
	let killed = '';
	if (
		target &&
		identifyKept(target.pid, target.argv, target.keeper, target.keeperArgv ?? [], target.started) === 'match'
	) {
		try {
			process.kill(target.pid, 'SIGKILL');
			killed = `, sending SIGKILL to ${target.pid}, which it had sent SIGTERM and unlocked,`;
		} catch {
			// Gone since, which is the outcome asked for.
		}
	}
	log(options, `received ${signal}; exiting${killed} and leaving its lock to the next claim.`);
	process.exit(0);
}

/**
 * Start the reaper, commit its pid on its own lock under the claim's token, and exit, so the thread that spawned this
 * reaps it at once and init adopts the reaper. A reaper the host spawned itself dies a zombie once that thread is gone.
 *
 * @param {string[]} argv `--token <token> --version <version>`, then the reaper's own flags.
 */
async function launch(argv) {
	const [tokenFlag, token = '', versionFlag, version = '', ...flags] = argv;
	const options = parseArgs(flags);
	if (tokenFlag !== '--token' || versionFlag !== '--version' || !token || !options.selfLock) {
		process.stderr.write('reaper launcher: --token and --version come first, and --self-lock must be given\n');
		process.exit(2);
	}
	// Refused here as the reaper would refuse them, before a pid that exits at once is committed as the reaper.
	refuseNothingToWatch(options);
	// The path the thread passed, which its claim records. The guard at the foot of this file runs launch() only when
	// argv[1] is this module's own URL, so the two cannot differ here: reached through a symlink, Node resolves
	// import.meta.url and leaves argv[1] as given, the guard is false and nothing runs, and the thread reads that clean
	// exit with no pid as a failed launch.
	const reaperArgv = [process.execPath, process.argv[1] ?? fileURLToPath(import.meta.url), ...flags];
	// Inherited, so whatever stdio the host gave this launcher is the reaper's.
	const reaper = spawn(process.execPath, reaperArgv.slice(1), { stdio: 'inherit' });
	if (!reaper.pid) {
		reaper.once('error', (error) => {
			process.stderr.write(`reaper launcher: the reaper could not be started: ${error.message}\n`);
			process.exit(1);
		});
		return;
	}
	/** @type {string} */
	let outcome;
	try {
		const host = { host: options.hostPid };
		outcome = await commitLock(options.selfLock, token, reaper.pid, Number.parseInt(version, 10), reaperArgv, host);
	} catch (error) {
		outcome = errorMessage(error);
	}
	if (outcome === 'written') process.exit(0);
	// The claim is not this launcher's any more, and a reaper under no lock would run beside the one that holds it.
	reaper.kill('SIGKILL');
	process.stderr.write(`reaper launcher: committing the reaper's pid found its lock ${outcome}; stopped it\n`);
	process.exit(3);
}

/** @param {ReaperOptions} options */
function refuseNothingToWatch(options) {
	if (Number.isInteger(options.hostPid) && options.hostPid > 0 && options.pidDir) return;
	// A reaper with nothing to watch would sit forever, and a non-positive pid selects a process GROUP.
	process.stderr.write('reaper: --host-pid must be a positive integer and --pid-dir must be given\n');
	process.exit(2);
}

// Executed directly, which is how a host uses this. Guarded so the exports above stay importable by a
// test without a reaper loop starting as a side effect.
const executed = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executed && process.argv[2] === LAUNCH_FLAG) void launch(process.argv.slice(3));
else if (executed) {
	const options = parseArgs(process.argv.slice(2));
	refuseNothingToWatch(options);
	// Registered before run() starts waiting: a signal that lands during the wait is the case this exists for.
	process.on('SIGTERM', () => stopOnSignal(options, 'SIGTERM'));
	process.on('SIGINT', () => stopOnSignal(options, 'SIGINT'));
	run(options).catch((/** @type {unknown} */ error) => {
		process.stderr.write(`reaper: ${errorMessage(error)}\n`);
		process.exit(1);
	});
}
