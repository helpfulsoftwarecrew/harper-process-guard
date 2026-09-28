// @ts-check
// A detached process, because nothing inside the host survives its death: there is no worker shutdown
// hook, and SIGKILL fires no handler. Spawned by path, never imported.
import { closeSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { identify, isAlive, STOP_POLL_MS, waitWhileAlive } from './identity.js';
import { errorMessage } from './exit.js';
import { readLock, unlinkQuietly } from './lock.js';

const DEFAULT_WATCH_POLL_MS = 1000;
const DEFAULT_TERM_GRACE_MS = 5000;

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

/**
 * The lock goes BEFORE the signal: a thread reading a dying pid adopts a corpse and never retries, where
 * one finding nothing starts a replacement.
 *
 * @param {ReaperOptions} options @param {{ path: string; pid: number; argv: readonly string[] }} target
 */
export async function reapTarget(options, target) {
	// A pid of 0 identifies as 'differs' rather than reaching kill(2), where it would name a process GROUP.
	const verdict = identify(target.pid, target.argv);
	unlinkQuietly(target.path);
	if (verdict !== 'match') {
		log(options, `${target.path}: pid ${target.pid} is not that process (${verdict}); left alone`);
		return;
	}

	try {
		process.kill(target.pid, 'SIGTERM');
		log(options, `sent SIGTERM to ${target.pid} (${target.path})`);
	} catch (error) {
		log(options, `could not SIGTERM ${target.pid}: ${errorMessage(error)}`);
		return;
	}

	const grace = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
	await waitWhileAlive(target.pid, Date.now() + grace, STOP_POLL_MS);
	if (!isAlive(target.pid)) return;

	// SIGKILL reaches only a pid identified above; signalling an unnamed one would be this module's own defect.
	try {
		process.kill(target.pid, 'SIGKILL');
		log(options, `${target.pid} ignored SIGTERM for ${grace}ms; sent SIGKILL`);
	} catch (error) {
		log(options, `could not SIGKILL ${target.pid}: ${errorMessage(error)}`);
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
			if (options.selfLock) unlinkQuietly(options.selfLock);
			return;
		}
		await delay(100);
	}

	// Enumerated now rather than at launch: a thread that joined this reaper later left its lock here too.
	for (const target of collectTargets(options)) await reapTarget(options, target);
	if (options.selfLock) unlinkQuietly(options.selfLock);
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
 * An unhandled SIGTERM kills this process before its own code runs, so without this a caller that signals
 * the reaper directly leaves its lock behind forever.
 *
 * @param {ReaperOptions} options @param {NodeJS.Signals} signal
 */
function stopOnSignal(options, signal) {
	log(options, `received ${signal}; leaving its own lock for a replacement and exiting.`);
	if (options.selfLock) unlinkQuietly(options.selfLock);
	process.exit(0);
}

// Executed directly, which is how a host uses this. Guarded so the exports above stay importable by a
// test without a reaper loop starting as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const options = parseArgs(process.argv.slice(2));
	if (!Number.isInteger(options.hostPid) || options.hostPid <= 0 || !options.pidDir) {
		// A reaper with nothing to watch would sit forever, and a non-positive pid selects a process GROUP.
		process.stderr.write('reaper: --host-pid must be a positive integer and --pid-dir must be given\n');
		process.exit(2);
	}
	// Registered before run() starts waiting: a signal that lands during the wait is the case this exists for.
	process.on('SIGTERM', () => stopOnSignal(options, 'SIGTERM'));
	process.on('SIGINT', () => stopOnSignal(options, 'SIGINT'));
	run(options).catch((/** @type {unknown} */ error) => {
		process.stderr.write(`reaper: ${errorMessage(error)}\n`);
		process.exit(1);
	});
}
