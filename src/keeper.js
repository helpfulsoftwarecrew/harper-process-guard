// @ts-check
// The guarded process's parent, started through a launcher that exits at once so init adopts it. Its exit
// status and its reaping then outlive any worker thread, and it writes each death beside the lock for all of them.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describeExit, errorMessage } from './exit.js';
import { startedAt } from './identity.js';
import { commitLock, readLock, releaseLock, unlinkQuietly } from './lock.js';

export const KEEPER_SCRIPT = fileURLToPath(import.meta.url);

/** What a supervisor sends on the way down; each is forwarded, and the process is not started again after one. */
const STOP_SIGNALS = /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP']);
/** How long a process started under a lock this keeper lost gets after SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 5000;
/** How long a keeper on its way out waits for relayed output to reach its reader. */
const RELAY_FLUSH_MS = 1000;

/**
 * What the keeper did about one death, or about a start that never ran. Only `restarting` leaves it running.
 *
 * @typedef {object} ExitRecord
 * @property {string} token The lock token the keeper holds.
 * @property {number} keeper Pid of the keeper, or 0 when its launcher could not start one.
 * @property {number} pid The process that ended, or 0 when none had started.
 * @property {number | null} code
 * @property {string | null} signal
 * @property {'released' | 'restarting' | 'gave-up' | 'gone' | 'taken' | 'failed'} outcome
 * @property {number} restarts Restarts made so far, counting the one `restarting` announces.
 * @property {number} waitMs How long after `at` the announced restart starts.
 * @property {number} at
 * @property {boolean} released Whether the keeper removed the lock itself.
 * @property {string} [error]
 */

/**
 * @typedef {object} KeeperOptions
 * @property {string} lock The lock file whose token the keeper holds.
 * @property {string} token
 * @property {number} version
 * @property {number} hostPid The host that launched it, which the lock keeps naming as its holder.
 * @property {number} restarts Restarts made before this keeper, which count toward the cap.
 * @property {number} restartMax
 * @property {number} restartBaseMs
 * @property {readonly number[]} piped The descriptors a thread piped: the keeper holds stdin open and relays each output.
 * @property {readonly string[]} argv The guarded process's command line, binary first.
 */

const OUTCOMES = new Set(['released', 'restarting', 'gave-up', 'gone', 'taken', 'failed']);

/** @param {string} lockFile */
export const recordPath = (lockFile) => `${lockFile}.exit`;

/** The last record for `lockFile`, or null for none and for one this version cannot read. @param {string} lockFile @returns {ExitRecord | null} */
export function readRecord(lockFile) {
	try {
		const record = JSON.parse(readFileSync(recordPath(lockFile), 'utf-8'));
		if (typeof record?.token !== 'string' || !OUTCOMES.has(record.outcome) || !Number.isInteger(record.pid))
			return null;
		return /** @type {ExitRecord} */ (record);
	} catch {
		return null;
	}
}

/** Temp and rename, so a thread reads the previous record or this one and never half of either. @param {string} lockFile @param {ExitRecord} record */
function writeRecord(lockFile, record) {
	const file = recordPath(lockFile);
	const temp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(record), 'utf-8');
		renameSync(temp, file);
	} catch {
		// A thread that finds no record answers from the lock instead, so this costs precision and not the process.
		unlinkQuietly(temp);
	}
}

/** The flags a keeper is started with, the guarded command line last and verbatim. @param {KeeperOptions} options */
export function keeperArgs(options) {
	return [
		'--lock',
		options.lock,
		'--token',
		options.token,
		'--version',
		String(options.version),
		'--host-pid',
		String(options.hostPid),
		'--restarts',
		String(options.restarts),
		'--restart-max',
		String(options.restartMax),
		'--restart-base-ms',
		String(options.restartBaseMs),
		...(options.piped.length > 0 ? ['--piped', options.piped.join(',')] : []),
		'--',
		...options.argv,
	];
}

/** @param {readonly string[]} argv @returns {KeeperOptions} */
export function parseArgs(argv) {
	const split = argv.indexOf('--');
	const flags = split === -1 ? argv : argv.slice(0, split);
	/** @type {KeeperOptions} */
	const options = {
		lock: '',
		token: '',
		version: 0,
		hostPid: 0,
		restarts: 0,
		restartMax: 0,
		restartBaseMs: 0,
		piped: [],
		argv: split === -1 ? [] : argv.slice(split + 1),
	};
	const int = (/** @type {string} */ value) => Number.parseInt(value, 10);
	for (let i = 0; i + 1 < flags.length; i += 2) {
		const value = flags[i + 1] ?? '';
		switch (flags[i]) {
			case '--lock':
				options.lock = value;
				break;
			case '--token':
				options.token = value;
				break;
			case '--version':
				options.version = int(value);
				break;
			case '--host-pid':
				options.hostPid = int(value);
				break;
			case '--restarts':
				options.restarts = int(value);
				break;
			case '--restart-max':
				options.restartMax = int(value);
				break;
			case '--restart-base-ms':
				options.restartBaseMs = int(value);
				break;
			case '--piped':
				options.piped = value
					.split(',')
					.map(int)
					.filter((fd) => fd === 0 || fd === 1 || fd === 2);
				break;
		}
	}
	return options;
}

/** The leading run of a keeper's command line, which names its lock and token and so no other process.
 * @param {string} command What the keeper runs as. @param {{ lock: string, token: string }} options */
export function keeperIdentity(command, { lock, token }) {
	return [command, KEEPER_SCRIPT, '--keep', '--lock', lock, '--token', token];
}

/** @param {KeeperOptions} options @param {number} keeper @returns {ExitRecord} */
const blank = (options, keeper) => ({
	token: options.token,
	keeper,
	pid: 0,
	code: null,
	signal: null,
	outcome: 'failed',
	restarts: options.restarts,
	waitMs: 0,
	at: Date.now(),
	released: false,
});

/** Start the keeper and exit, so the thread that spawned this reaps it at once and init adopts the keeper. @param {string[]} flags */
function launch(flags) {
	const keeper = spawn(process.execPath, [KEEPER_SCRIPT, '--keep', ...flags], { stdio: 'inherit' });
	if (keeper.pid) process.exit(0);
	keeper.once('error', (error) => {
		const options = parseArgs(flags);
		writeRecord(options.lock, { ...blank(options, 0), error: `its keeper could not be started: ${error.message}` });
		process.exit(1);
	});
}

/** @param {import('node:child_process').ChildProcess} child @param {Promise<{ code: number | null, signal: string | null }>} exited */
async function stopChild(child, exited) {
	child.kill('SIGTERM');
	const graced = await Promise.race([exited, delay(TERM_GRACE_MS, null, { ref: false })]);
	if (graced === null) child.kill('SIGKILL');
	return exited;
}

/** @typedef {{ attach: (source: import('node:stream').Readable | null) => void, flush: () => Promise<void> }} Relay */

/**
 * The pipe a thread reads, held here so the process writes to the keeper instead. Once the thread is gone a write
 * fails here and the output is dropped, where the process itself would have died of it on its next write.
 *
 * @param {number} fd @returns {Relay | null} Null for a descriptor that is not a pipe, which the process inherits.
 */
function relayTo(fd) {
	/** @type {Socket} */
	let out;
	try {
		out = new Socket({ fd, readable: false, writable: true });
	} catch {
		return null;
	}
	/** @type {Set<import('node:stream').Readable>} */
	const sources = new Set();
	let open = true;
	out.on('error', () => {
		open = false;
		// pipe() has unpiped each source and paused it; resumed, it is read and dropped, so the process never blocks.
		for (const source of sources) source.resume();
	});
	return {
		attach(source) {
			if (!source) return;
			source.on('error', () => {});
			sources.add(source);
			source.once('close', () => sources.delete(source));
			if (open) source.pipe(out, { end: false });
			else source.resume();
		},
		async flush() {
			const grace = new AbortController();
			const drained = (async () => {
				await Promise.all([...sources].map((source) => once(source, 'close').catch(() => {})));
				if (open && out.writableLength > 0) await once(out, 'drain').catch(() => {});
			})();
			await Promise.race([drained, delay(RELAY_FLUSH_MS, undefined, { signal: grace.signal }).catch(() => {})]);
			grace.abort();
		},
	};
}

/**
 * Start the process, record its pid on the lock, and answer each death: a deliberate one releases the lock, a crash
 * is restarted with the guard's backoff while the lock still carries this keeper's token. Resolves to an exit code.
 *
 * @param {KeeperOptions} options
 */
export async function keep(options) {
	/** @type {NodeJS.Signals | null} */
	let stopping = null;
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	const woken = new AbortController();
	for (const signal of STOP_SIGNALS) {
		process.on(signal, () => {
			stopping ??= signal;
			if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
			woken.abort();
		});
	}
	const owner = { host: options.hostPid, keeper: process.pid, keeperArgv: keeperIdentity(process.argv0, options) };
	let restarts = options.restarts;
	let last = { pid: 0, code: /** @type {number | null} */ (null), signal: /** @type {string | null} */ (null) };
	/** @param {Partial<ExitRecord>} fields */
	const record = (fields) =>
		writeRecord(options.lock, { ...blank(options, process.pid), ...last, restarts, ...fields });
	/**
	 * Release the lock with `fields` recorded inside the gate first, so no reader finds the lock gone without its
	 * reason. A lock already gone or taken is recorded as that instead, except for a start that failed.
	 *
	 * @param {Pick<ExitRecord, 'outcome'> & Partial<ExitRecord>} fields
	 */
	const release = async (fields) => {
		try {
			const outcome = await releaseLock(options.lock, options.token, () => record({ ...fields, released: true }));
			if (outcome !== 'written') record({ ...fields, ...(fields.outcome === 'failed' ? {} : { outcome }) });
		} catch (error) {
			// A failed start keeps its own reason first, since the thread reports this record as why it never ran.
			const failure = errorMessage(error);
			const reason = fields.error ? `${fields.error} (its keeper could not release the lock: ${failure})` : failure;
			record({ ...fields, error: reason });
		}
	};

	/** Whether the lock stopped carrying this keeper's token, recorded if so; nothing is started under a lost lock. */
	const lost = () => {
		const held = readLock(options.lock);
		if (held?.token === options.token) return false;
		record({ outcome: held ? 'taken' : 'gone' });
		return true;
	};

	const relays = new Map(options.piped.filter((fd) => fd !== 0).flatMap((fd) => [[fd, relayTo(fd)]]));
	// The thread's end of a piped stdin closes once the launcher exits, so the process gets one this keeper holds.
	const holdStdin = options.piped.includes(0);
	/** @type {import('node:child_process').StdioOptions} */
	const stdio = [holdStdin ? 'pipe' : 0, relays.get(1) ? 'pipe' : 1, relays.get(2) ? 'pipe' : 2];
	try {
		for (;;) {
			const started = spawn(options.argv[0] ?? '', options.argv.slice(1), { stdio });
			child = started;
			// Kept, not once: a second 'error', from a kill that fails, would otherwise end the keeper.
			/** @type {Promise<unknown>} */
			const failed = new Promise((resolve) => started.on('error', resolve));
			if (!started.pid) {
				// The same message a thread's own spawn reports, so an operator reads one sentence either way.
				await release({ outcome: 'failed', error: errorMessage(await failed) });
				return 1;
			}
			const pid = started.pid;
			/** @type {Promise<{ code: number | null, signal: string | null }>} */
			const exited = new Promise((resolve) => started.once('exit', (code, signal) => resolve({ code, signal })));
			// Never written or ended, so the process reads end-of-file once this keeper is gone and not before.
			started.stdin?.on('error', () => {});
			relays.get(1)?.attach(started.stdout);
			relays.get(2)?.attach(started.stderr);

			// Read before the gate is taken, and recorded so the process stays identifiable if this keeper is killed.
			const startTime = startedAt(pid);
			/** @type {string} */
			let committed;
			try {
				const recorded = startTime === null ? owner : { ...owner, started: startTime };
				committed = await commitLock(options.lock, options.token, pid, options.version, options.argv, recorded);
			} catch (error) {
				committed = errorMessage(error);
			}
			if (committed !== 'written') {
				// No lock names this process, so nothing but this keeper would ever stop it.
				last = { pid, ...(await stopChild(started, exited)) };
				if (committed === 'gone' || committed === 'taken') record({ outcome: committed });
				else await release({ outcome: 'failed', error: committed });
				return 0;
			}
			if (stopping !== null) started.kill(stopping);
			last = { pid, ...(await exited) };
			child = null;

			if (stopping !== null || describeExit(last.code, last.signal).deliberate) {
				await release({ outcome: 'released' });
				return 0;
			}
			// The reaper and a sibling's takeover both change the lock before they signal, so either reads here.
			if (lost()) return 0;
			if (restarts + 1 > options.restartMax) {
				await release({ outcome: 'gave-up' });
				return 0;
			}
			const waitMs = options.restartBaseMs * 2 ** restarts;
			restarts += 1;
			record({ outcome: 'restarting', waitMs });
			await delay(waitMs, undefined, { signal: woken.signal }).catch(() => {});
			if (stopping !== null) {
				await release({ outcome: 'released' });
				return 0;
			}
			if (lost()) return 0;
		}
	} finally {
		await Promise.all([...relays.values()].map((relay) => relay?.flush()));
	}
}

// Executed directly, which is how a thread uses this; imported, it only lends its helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [mode, ...flags] = process.argv.slice(2);
	const options = parseArgs(flags);
	// Nothing of its own is written to stdio: a pipe to a thread that is gone would end this process on the first write.
	if (!options.lock || !options.token || options.argv.length === 0) process.exit(2);
	if (mode === '--launch') launch(flags);
	else if (mode === '--keep')
		keep(options).then(
			(code) => process.exit(code),
			(error) => {
				writeRecord(options.lock, { ...blank(options, process.pid), error: errorMessage(error) });
				process.exit(1);
			}
		);
	else process.exit(2);
}
