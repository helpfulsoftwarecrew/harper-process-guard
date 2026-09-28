// @ts-check
// The node, where every consumer is one thread of many: one writer for periodic work, one value every thread
// reads, and process state read back off the locks rather than remembered per thread.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

import { argvOf, identify as identifyPid } from './identity.js';
import { readLock } from './lock.js';

/** Bytes per /proc kB field. */
const KB = 1024;

/** A filename component from an arbitrary key. */
const safe = (/** @type {string} */ key) => key.replace(/[^\w.-]+/g, '_');

/**
 * A value every thread can read, one file per key. Module memory is per thread, and consecutive reads of
 * one value land on different threads.
 *
 * @param {string | undefined} dir @param {string} kind Distinguishes one consumer's marks from another's.
 * @returns {{ get: (key: string) => number | undefined, set: (key: string, value: number) => void }}
 */
export function sharedMarks(dir, kind) {
	if (!dir) {
		// Nothing to share through. This thread's memory is what is left, and all a single-threaded caller needs.
		/** @type {Map<string, number>} */
		const own = new Map();
		return { get: (key) => own.get(key), set: (key, value) => void own.set(key, value) };
	}
	const path = (/** @type {string} */ key) => join(dir, `${safe(kind)}-${safe(key)}.mark`);
	return {
		get(key) {
			try {
				const value = Number(readFileSync(path(key), 'utf-8').trim());
				return Number.isFinite(value) && value > 0 ? value : undefined;
			} catch {
				// No mark yet, or an unreadable one. This read has nothing behind it.
				return undefined;
			}
		},
		set(key, value) {
			const target = path(key);
			const scratch = `${target}.${process.pid}.${threadId}`;
			try {
				writeFileSync(scratch, String(value));
				renameSync(scratch, target);
			} catch {
				// A read-only or missing directory costs the recall, not the caller.
				try {
					unlinkSync(scratch);
				} catch {}
			}
		},
	};
}

/**
 * Which thread does work the node wants done once: an ungated timer runs per thread and multiplies every
 * gauge by the thread count. A `<holder> <timestamp>` file refreshed each tick, so takeover needs no unlock.
 *
 * @param {object} options
 * @param {string} options.dir @param {string} options.file Name of the claim, so two kinds of work do not share one.
 * @param {string} options.holder @param {number} options.staleMs
 * @param {number} [options.now] @param {typeof readFileSync} [options.read] @param {typeof writeFileSync} [options.write]
 * @returns {boolean} whether the caller may do the work this tick
 */
export function claimSingleton({
	dir,
	file,
	holder,
	staleMs,
	now = Date.now(),
	read = readFileSync,
	write = writeFileSync,
}) {
	const path = join(dir, file);
	/** @type {string[]} */
	let held;
	try {
		held = String(read(path, 'utf-8')).trim().split(/\s+/);
	} catch {
		// No claim yet, or one this thread cannot read. Either way nobody demonstrably holds it.
		held = [];
	}
	const [heldBy, stamp] = held;
	const at = Number(stamp);
	// A stamp ahead of `now` is live, not expired: claimants share one clock, so the future means a correction
	// under a living holder, and it resolves on that holder's next tick.
	const live = Number.isFinite(at) && now - at < staleMs;
	if (live && heldBy !== holder) return false;
	try {
		write(path, `${holder} ${now}\n`);
	} catch {
		// An unwritable directory is reported elsewhere. Proceeding would put every thread on the job.
		return false;
	}
	return true;
}

/**
 * How long a claim survives unrefreshed: three cadences, so a holder that misses one tick to a slow read does
 * not hand the work over and double its output for an interval.
 *
 * @param {number} intervalSeconds
 */
export const claimStaleMs = (intervalSeconds) => intervalSeconds * 3000;

/**
 * What one supervised process costs, or null where the platform cannot say. Only Linux answers without
 * spawning on a schedule or a native addon; a Go process's own `memstats` reports heap, not resident size.
 *
 * @param {number} pid @param {string} [platform] @param {(p: string) => string} [read]
 * @returns {{ rssBytes: number, threads: number } | null}
 */
export function readProcess(pid, platform = process.platform, read = undefined) {
	if (platform !== 'linux') return null;
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const readFile = read ?? ((/** @type {string} */ p) => readFileSync(p, 'utf-8'));
	let status;
	try {
		status = readFile(`/proc/${pid}/status`);
	} catch {
		// Gone between listing and reading, which is ordinary while processes are being killed.
		return null;
	}
	const field = (/** @type {string} */ name) => {
		const found = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status);
		return found ? Number(found[1]) : undefined;
	};
	const rssKb = field('VmRSS');
	if (rssKb === undefined) return null;
	return { rssBytes: rssKb * KB, threads: field('Threads') ?? 0 };
}

/**
 * This process's own cost, the same on every platform: the host is Node, so `memoryUsage().rss` is its real
 * resident size, which is why only the native processes beside it go unmeasured.
 *
 * @param {NodeJS.Process} [self]
 */
export function selfProcess(self = process) {
	const { rss } = self.memoryUsage();
	return { rssBytes: rss, threads: 0 };
}

// -- The processes, as the node has them rather than as one thread left them -------------------------------

/** How often a thread checks the reaper is still there, and the longest it waits after a failed relaunch. */
export const REAPER_WATCH_MS = 60_000;
const REAPER_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * A lock naming a real process, or undefined. readLock parses; this adds that pid 0 is the claim-in-flight
 * sentinel and identifies against nothing.
 *
 * @param {string} file
 */
export function heldProcess(file) {
	const lock = readLock(file);
	if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return undefined;
	return lock;
}

/**
 * The reaper as it is now, not as bootstrap left it: the state is built once and a status endpoint copies it,
 * so without this a dead reaper reads as started under its dead pid.
 *
 * @param {Record<string, unknown> | undefined} reaper @param {string | undefined} pidDir
 * @param {string} [defaultName] Used only when the state carries no name, which a state guard() built always has.
 */
export function currentReaper(reaper, pidDir, defaultName) {
	if (!reaper || !pidDir) return reaper;
	const name = typeof reaper.name === 'string' ? reaper.name : defaultName;
	// Nothing names the lock. Returned unchanged rather than dead: a missing name is not a missing reaper.
	if (!name) return reaper;
	const held = heldProcess(join(pidDir, `${name}.pid`));
	if (held && identifyPid(held.pid, held.argv) === 'match') {
		// The pid too: a reaper another thread replaced runs under a number this boot state never saw.
		return { ...reaper, started: true, pid: held.pid };
	}
	const why = !held
		? `no lock for ${name} under ${pidDir}`
		: argvOf(held.pid) === null
			? `${name}'s lock names pid ${held.pid}, which nothing holds`
			: `${name}'s lock names pid ${held.pid}, which is running something else`;
	return {
		...reaper,
		started: false,
		pid: undefined,
		error: `${why}. Nothing is reaping this node's processes: if it dies without running its exit handlers, they outlive it.`,
	};
}

/**
 * Harper's spawn hands back the pid in <root>/pids/<name>.pid when it answers kill(pid, 0), and after a
 * restart a thread of Harper itself answers for one. A file naming the real process, or a dead one, stays.
 *
 * @param {string | null} root
 * @param {Array<{ name: string; argv?: readonly string[]; script?: string }>} named
 * @param {import('./host.js').Log} log
 * @param {string} [label] How the component names itself in these lines. Defaults to this package.
 */
export function clearStaleHostPidFiles(root, named, log, label = 'process guard') {
	if (!root) return;
	for (const { name, argv, script } of named) {
		const file = join(root, 'pids', `${name}.pid`);
		let pid;
		try {
			pid = Number.parseInt(readFileSync(file, 'utf-8'), 10);
		} catch {
			continue;
		}
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const running = argvOf(pid);
		if (running === null) continue;
		const ours = argv
			? identifyPid(pid, argv) === 'match'
			: running.some((argument) => argument.endsWith(script ?? ' '));
		if (ours) continue;
		try {
			unlinkSync(file);
			log.warn(
				`${label}: removed ${file}, the host's own pid file for ${name}: it named pid ${pid}, which ` +
					`is running \`${running.join(' ')}\`, and the host would have handed that pid back as the ${name} ` +
					`instead of starting one.`
			);
		} catch (error) {
			log.error(
				`${label}: could not remove ${file}, which names pid ${pid} running something else: ` +
					`${error instanceof Error ? error.message : String(error)}. The host will hand that pid back as the ${name} rather than start one.`
			);
		}
	}
}

/**
 * What the node has, for a thread that has nothing. A thread's own refusal is a diagnostic rather than the
 * node's health, and a thread that watched its process die reads back for the opposite reason.
 *
 * @param {Record<string, any>} state @param {string | undefined} pidDir @param {string} [supervision]
 */
export function nodeProcess(state, pidDir, supervision = 'guard') {
	if (!state || !pidDir || !state.name) return state;
	// Only the bundled guard's own locks mean anything here. A host that supervises natively keeps live
	// state instead, and a lock this package did not write proves nothing about that host's process.
	if (supervision !== 'guard') return state;
	const unstartedHere = state.started === false;
	const diedHere = state.exited === true && supervision === 'guard';
	if (!unstartedHere && !diedHere) return state;
	const held = heldProcess(join(pidDir, `${state.name}.pid`));
	if (!held || identifyPid(held.pid, held.argv) !== 'match')
		// Nothing of this name runs on the node. The dead pid stays: `started: false` says it is not running,
		// and which pid died is what an operator reads the log for.
		return diedHere ? { ...state, started: false } : state;
	return {
		...state,
		started: true,
		adopted: true,
		exited: false,
		pid: held.pid,
		// No verdict against this pid from this thread, which makes the reader retake one.
		verified: undefined,
		verifyDetail: undefined,
		verifiedPid: null,
		error: undefined,
		refused: state.error,
	};
}

/**
 * Keep a reaper on the node, since a node whose reaper died has nothing to stop its orphans. The check is a
 * lock read, and only an absent reaper reaches `relaunch` and its lock.
 *
 * @param {object} options
 * @param {string} options.pidDir @param {Record<string, unknown>} options.reaper
 * @param {() => Promise<unknown>} options.relaunch @param {import('./host.js').Log} options.log
 * @param {string} [options.label] @param {string} [options.reaperName]
 * @param {number} [options.everyMs] @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @returns {{ stop: () => void, tick: () => Promise<'present'|'relaunched'|'failed'|'backoff'> }}
 */
export function keepReaperAlive({
	pidDir,
	reaper,
	relaunch,
	log,
	label = 'process guard',
	reaperName = undefined,
	everyMs = REAPER_WATCH_MS,
	setTimer = setInterval,
}) {
	let backoffUntil = 0;
	let wait = everyMs;
	let running = false;

	const tick = async () => {
		// One relaunch at a time per thread: a spawn plus its lock claim can outlast the interval.
		if (running) return 'present';
		if (currentReaper(reaper, pidDir, reaperName)?.started) {
			wait = everyMs;
			return 'present';
		}
		if (Date.now() < backoffUntil) return 'backoff';
		running = true;
		try {
			await relaunch();
			const now = currentReaper(reaper, pidDir, reaperName);
			if (now?.started) {
				wait = everyMs;
				log.warn(`${label}: the reaper was gone and has been relaunched as pid ${now.pid}.`);
				return 'relaunched';
			}
			// It did not come back. Widen the gap rather than spawn every minute against whatever refuses.
			wait = Math.min(wait * 2, REAPER_BACKOFF_MAX_MS);
			backoffUntil = Date.now() + wait;
			log.error(
				`${label}: relaunching the reaper left none running; next attempt in ${Math.round(wait / 1000)}s. ${now?.error ?? ''}`
			);
			return 'failed';
		} catch (error) {
			wait = Math.min(wait * 2, REAPER_BACKOFF_MAX_MS);
			backoffUntil = Date.now() + wait;
			log.error(
				`${label}: relaunching the reaper threw: ${error instanceof Error ? error.message : String(error)}. Next attempt in ${Math.round(wait / 1000)}s`
			);
			return 'failed';
		} finally {
			running = false;
		}
	};

	const timer = setTimer(() => {
		tick().catch(() => {});
	}, everyMs);
	// Never the reason a worker thread stays alive.
	timer?.unref?.();
	return { stop: () => clearInterval(timer), tick };
}
