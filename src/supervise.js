// @ts-check
// What a thread does once the lock is settled. A thread that only joined still watches and still answers
// a death, because reporting success and then supervising nothing is the defect, joined or started.
import { accessSync, constants, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { aliveBudgetMs, argvOf, compareArgv, identify, identifyKept, isAlive } from './identity.js';
// Which exits mean somebody shut it down lives in exit.js, so this file and a consumer's status endpoint
// cannot disagree about the same signal. Restarting into one of these fights the operator.
import { describeSpawnFailure, errorMessage, isDeliberate } from './exit.js';
import { KEEPER_SCRIPT, keeperArgs, readRecord } from './keeper.js';
import {
	claimLock,
	commitLock,
	gateWaitMs,
	keeperBootMs,
	lockPath,
	readLock,
	releaseLock,
	releaseUnstarted,
	safeLockWrite,
	START_FAILURE_MS,
} from './lock.js';

/**
 * @typedef {object} Tuning
 * @property {number} deathPollMs Liveness cadence backing every watch. Not sub-second: this reports a death rather than reacting to one, and on darwin each check forks a `ps`.
 * @property {number} restartMax
 * @property {number} restartBaseMs
 */

/** @type {Tuning} */
export const DEFAULT_TUNING = { deathPollMs: 2000, restartMax: 5, restartBaseMs: 1000 };

/** @typedef {import('node:child_process').ChildProcess} SpawnedChild */

/**
 * The caller's spawn, injected so a host's constrained child_process can be handed in. `name` is Harper's
 * extension: its spawn throws without one and stock Node ignores it.
 *
 * @typedef {(command: string, args: string[], options: import('node:child_process').SpawnOptions & { name?: string }) => SpawnedChild} Spawn
 */

/**
 * @typedef {object} Descriptor
 * @property {string} name Lock filename stem.
 * @property {string} title How messages name it.
 * @property {string} binaryPath
 * @property {readonly string[]} args
 * @property {readonly string[]} argv `[binaryPath, ...args]`, which is the process's identity.
 * @property {import('node:child_process').SpawnOptions} spawnOptions
 * @property {string} [exitHint] Appended to the non-zero-exit report, for the caller's domain knowledge.
 */

/**
 * @typedef {object} ProcessState
 * @property {string} name
 * @property {string} title
 * @property {number | undefined} [pid]
 * @property {boolean} started
 * @property {boolean} adopted True when this thread joined a process it did not start, a keeper's restart included.
 * @property {boolean} exited True once this thread has seen it die, with `code` and `signal` already set wherever either can be known.
 * @property {number} restarts
 * @property {string | undefined} [error]
 * @property {boolean} [verified] Set from the caller's verify().
 * @property {string | undefined} [verifyDetail]
 * @property {number | undefined} [code] Exit code of the last death, from its keeper or from a child this thread spawned.
 * @property {string | undefined} [signal] Signal that ended the last death, from the same two sources.
 */

/**
 * @typedef {object} Context
 * @property {string} pidDir
 * @property {Spawn} spawn
 * @property {number} version
 * @property {boolean} stopOrphans
 * @property {import('./host.js').Log} log
 * @property {number} claimTimeoutMs
 * @property {string[]} report
 * @property {Tuning} tuning
 * @property {{ stopping: boolean }} run Set by the caller's stop(), so no restart outruns a shutdown.
 * @property {boolean} [keeper] Start each process under a keeper, whose exit record every thread can read.
 */

/**
 * A keeper's claim on a lock, which is how a thread finds the record of a death it did not see. `since` is when this
 * thread began watching: a record from then on is about that process or a later one of the same keeper.
 *
 * @typedef {{ token: string, keeper: number, keeperArgv: readonly string[], since: number }} Kept
 */

/** Unref'd so nothing here holds the host open; outliving the host is the reaper's job. @param {number} ms */
const backoff = (ms) => delay(ms, undefined, { ref: false });

/** Absolute first because PATH cannot shadow it, then the bare `node` a host allowlist tends to carry. */
const KEEPER_COMMANDS = [process.execPath, 'node'];
/** A lock and record read each, so a start waiting on its keeper polls without forking anything. */
const KEEPER_WATCH_MS = 10;
/** How often a thread waiting for a keeper's record checks the keeper is still there to write one. */
const KEEPER_ALIVE_MS = 250;
/** Two node starts and a start-time read, then the keeper's own commit waiting out the gate. */
const keeperStartMs = () => keeperBootMs() + gateWaitMs() + aliveBudgetMs();

/** The descriptors a caller's stdio pipes to its thread; Node pipes any of the first three left unset.
 * @param {import('node:child_process').StdioOptions | undefined} stdio @returns {number[]} */
function pipedByThread(stdio) {
	const slots = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
	return [0, 1, 2].filter((fd) => {
		const slot = slots[fd];
		return slot === undefined || slot === null || slot === 'pipe' || slot === 'overlapped';
	});
}

/** Refuse a binary that is not there or not executable. spawn's own failure arrives asynchronously and names less. @param {string} binaryPath */
function preflight(binaryPath) {
	if (!binaryPath) throw new Error('its path could not be resolved');
	try {
		accessSync(binaryPath, constants.X_OK);
	} catch (error) {
		// The same sentence a post-spawn ENOENT or EACCES gets. Two wordings for one condition is how an
		// operator ends up with different advice depending on which check happened to run first.
		throw new Error(describeSpawnFailure(error, binaryPath));
	}
}

/** @param {SpawnedChild} child @returns {Promise<string>} */
function watchChild(child) {
	return new Promise((resolve) => {
		child.on('exit', (code, signal) => resolve(signal ? `signal ${signal}` : `exit code ${code}`));
	});
}

/**
 * How spawn reports a failure discoverable only after it returned. A real ChildProcess emits 'error'; a
 * host's wrapper owes nobody one, and this waits on a startup holding an uncommitted claim.
 *
 * @param {SpawnedChild} child @returns {Promise<string>}
 */
export function startFailure(child) {
	if (typeof child?.once !== 'function') return Promise.resolve('it returned no pid, and it reports no errors');
	return Promise.race([
		new Promise((resolve) => child.once('error', (error) => resolve(error.message))),
		// Held: an unanswerable spawn emits nothing, so this timer is the only thing that can settle the race.
		after(START_FAILURE_MS, `it returned no pid, and reported no error within ${START_FAILURE_MS}ms`, true),
	]);
}

/** @param {number} ms @param {string} value @returns {Promise<string>} */
function after(ms, value, hold = false) {
	// Unref'd by default: a backstop beside a poll that holds the loop must not keep a process alive. A race
	// where this timer is the only way out holds it, or nothing settles.
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(value), ms);
		if (!hold) timer.unref();
	});
}

// A host's wrapper may fire 'exit' late or never, so the poll backstops it but yields to the event, which
// alone names an exit code; reading the poll first misreads a deliberate shutdown as a crash.
/** @param {Context} ctx @param {SpawnedChild} child @param {number} pid A pid that names a running process; a start without one never reaches here. @returns {Promise<string>} */
function watchProcess(ctx, child, pid) {
	const event = typeof child?.on === 'function' ? watchChild(child) : null;
	const backstop = watchPid(ctx, pid).then((reason) =>
		event ? Promise.race([event, after(ctx.tuning.deathPollMs, reason)]) : reason
	);
	return event ? Promise.race([event, backstop]) : backstop;
}

/** Liveness is the signal a joined process has, and the backstop for one this thread started. Exported so
 * a test can drive the poll alone: inside a supervision tree nothing shows when the interval stops.
 * @param {Context} ctx @param {number} pid @returns {Promise<string>} */
export function watchPid(ctx, pid) {
	return new Promise((resolve) => {
		const timer = setInterval(() => {
			// Stopping ends the poll: this handle is unref'd, so nothing else ever clears it, and each tick
			// costs a `ps` on darwin for a process this thread no longer supervises.
			if (!ctx.run.stopping && isAlive(pid)) return;
			clearInterval(timer);
			resolve(ctx.run.stopping ? 'supervision stopped' : 'a liveness poll found the pid dead');
		}, ctx.tuning.deathPollMs);
		timer.unref();
	});
}

/**
 * Why a pid a spawn returned cannot be taken as the process, or undefined when it can. Node's own child
 * carries `spawnfile`; anything else handed back a pid it found, and that is trusted on identification alone.
 *
 * @param {{ pid?: number | undefined; spawnfile?: string | undefined }} child @param {{ argv: readonly string[]; binaryPath: string }} descriptor
 */
export function describeHandedBackPid(child, descriptor) {
	const pid = child.pid ?? 0;
	if (typeof child.spawnfile === 'string' || !isAlive(pid)) return undefined;
	const running = argvOf(pid);
	if (running === null || compareArgv(running, descriptor.argv) === 'match') return undefined;
	return (
		`handed back pid ${pid}, which is running \`${running.join(' ')}\` rather than ${descriptor.binaryPath}. ` +
		`The host reused a process it never checked; a stale pid file at the host's layer does this after a ` +
		`restart, and nothing here will supervise a stranger.`
	);
}

/** Every attempt-failure path: record the message on state, log it, and surface it on the caller's first try.
 * @param {Context} ctx @param {ProcessState} state @param {string} message @param {string} [logMessage] Defaults to `message`; the start-failure paths append the binary path. */
function failAttempt(ctx, state, message, logMessage = message) {
	state.error = message;
	ctx.log.error(`process guard: ${logMessage}`);
	if (state.restarts === 0) ctx.report.push(message);
}

/** Give back a claim after a failed attempt; a lock this thread never committed must not outlive it.
 * @param {Context} ctx @param {Descriptor} descriptor @param {string} token */
async function releaseClaim(ctx, descriptor, token) {
	const releaseError = await safeLockWrite(releaseLock(lockPath(ctx.pidDir, descriptor.name), token));
	if (releaseError) ctx.log.error(`process guard: releasing the ${descriptor.name} lock also failed: ${releaseError}`);
}

/**
 * One turn: refuse a start that cannot happen, settle the lock, start or join, watch. Resolves once the
 * process runs or was refused, and the watch outlives the call.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state @param {number} restarts
 */
async function attempt(ctx, descriptor, state, restarts) {
	state.restarts = restarts;
	state.exited = false;
	state.started = false;
	state.pid = undefined;
	state.error = undefined;
	state.code = undefined;
	state.signal = undefined;

	// Before the lock, where an orphan gets signalled: a node that cannot start a replacement must not stop
	// what it has.
	try {
		preflight(descriptor.binaryPath);
	} catch (error) {
		failAttempt(ctx, state, `cannot start the ${state.title}: ${errorMessage(error)}`);
		return;
	}

	/** @type {import('./lock.js').Claim} */
	let claim;
	try {
		claim = await claimLock({
			pidDir: ctx.pidDir,
			name: descriptor.name,
			version: ctx.version,
			argv: descriptor.argv,
			timeoutMs: ctx.claimTimeoutMs,
			stopOrphans: ctx.stopOrphans,
		});
	} catch (error) {
		failAttempt(
			ctx,
			state,
			`the ${descriptor.name} lock under ${ctx.pidDir} could not be taken: ${errorMessage(error)}`
		);
		return;
	}
	for (const note of claim.notes) {
		ctx.log.warn(`process guard: ${note}`);
		if (restarts === 0) ctx.report.push(note);
	}

	if (claim.outcome === 'adopted') {
		state.pid = claim.pid;
		state.started = true;
		state.adopted = true;
		ctx.log.info(
			`process guard: the ${state.title} already runs on this node (pid ${claim.pid}); this thread joined it.`
		);
		// Read now, while the lock is still there: the death below is answered from a lock that may be gone.
		const holder = readLock(lockPath(ctx.pidDir, descriptor.name));
		const kept =
			holder?.keeper !== undefined && holder.pid === claim.pid
				? { token: holder.token, keeper: holder.keeper, keeperArgv: holder.keeperArgv ?? [], since: Date.now() }
				: null;
		void answerDeath(ctx, descriptor, state, restarts, watchPid(ctx, claim.pid), null, holder?.host ?? 0, kept);
		return;
	}

	// A host that refuses node for the keeper still gets its process, started the way it was before keepers.
	if (ctx.keeper && (await startKept(ctx, descriptor, state, claim.token, restarts))) return;

	/** @type {SpawnedChild} */
	let child;
	try {
		// Last, so a caller's own spawnOptions cannot shadow the identity Harper's spawn gate checks against.
		child = ctx.spawn(descriptor.binaryPath, [...descriptor.args], {
			...descriptor.spawnOptions,
			name: descriptor.name,
		});
	} catch (error) {
		const message = `the spawn of the ${state.title} was refused: ${errorMessage(error)}`;
		failAttempt(ctx, state, message, `${message} (${descriptor.binaryPath})`);
		await releaseClaim(ctx, descriptor, claim.token);
		return;
	}

	// Attached before anything else: an unhandled 'error' on a ChildProcess takes the worker thread down.
	// Only a child with a pid is running, so only its 'error' is a kill or a send failing rather than a start.
	child.on('error', (error) => {
		if (child.pid) ctx.log.error(`process guard: the ${state.title} failed to execute: ${error.message}`);
	});

	// No pid means spawn failed after preflight passed. A bad shebang, a wrong-architecture binary or EAGAIN under
	// fork pressure arrives as 'error' and never as an exit, so a start read here supervises nothing.
	if (!child.pid) {
		const message = `the ${state.title} failed to start: ${await startFailure(child)}`;
		failAttempt(ctx, state, message, `${message} (${descriptor.binaryPath})`);
		await releaseClaim(ctx, descriptor, claim.token);
		return;
	}

	// A host reusing processes by name hands back a pid it never started, and after a restart a recycled one
	// answers for a thread of the host itself. Trusted on a positive identification and nothing less.
	const handedBack = describeHandedBackPid(child, descriptor);
	if (handedBack) {
		const message = `the spawn of the ${state.title} ${handedBack}`;
		failAttempt(ctx, state, message, `${message} (${descriptor.binaryPath})`);
		await releaseClaim(ctx, descriptor, claim.token);
		return;
	}

	// A second 'exit' listener alongside watchChild's own; Node fires both. A thread with no child of its own
	// reads state.code and state.signal from a keeper's record instead.
	child.on('exit', (code, signal) => {
		state.code = code ?? undefined;
		state.signal = signal ?? undefined;
	});
	const death = watchProcess(ctx, child, child.pid);
	state.pid = child.pid;
	state.started = true;
	state.adopted = false;
	const path = lockPath(ctx.pidDir, descriptor.name);
	const commitError = await safeLockWrite(commitLock(path, claim.token, child.pid, ctx.version, descriptor.argv));
	if (commitError) {
		state.error = `the ${descriptor.name} lock could not be updated with its pid: ${commitError}`;
		ctx.log.error(`process guard: ${state.error}`);
	}
	ctx.log.info(`process guard: started the ${state.title} (pid ${child.pid}): ${descriptor.argv.join(' ')}.`);
	void answerDeath(ctx, descriptor, state, restarts, death, claim.token, process.pid, null);
}

/**
 * Start the process under a keeper, which commits its pid on the lock under this claim's token. False when the
 * host refused every command the launcher was offered, and the caller starts the process itself.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state @param {string} token @param {number} restarts
 * @returns {Promise<boolean>}
 */
async function startKept(ctx, descriptor, state, token, restarts) {
	const path = lockPath(ctx.pidDir, descriptor.name);
	const { restartMax, restartBaseMs } = ctx.tuning;
	const flags = keeperArgs({
		lock: path,
		token,
		version: ctx.version,
		hostPid: process.pid,
		restarts,
		restartMax,
		restartBaseMs,
		piped: pipedByThread(descriptor.spawnOptions.stdio),
		argv: descriptor.argv,
	});
	const args = [KEEPER_SCRIPT, '--launch', ...flags];
	/** @type {string[]} */
	const refusals = [];
	for (const command of KEEPER_COMMANDS) {
		/** @type {SpawnedChild} */
		let launcher;
		try {
			// The caller's options reach the launcher, and its environment, cwd and stdio pass on to the process.
			launcher = ctx.spawn(command, args, { ...descriptor.spawnOptions, name: descriptor.name });
		} catch (error) {
			refusals.push(`${command}: ${errorMessage(error)}`);
			continue;
		}
		launcher.on?.('error', (error) => {
			if (launcher.pid)
				ctx.log.error(`process guard: the keeper launcher for the ${state.title} failed: ${error.message}`);
		});
		if (!launcher.pid) {
			refusals.push(`${command}: ${await startFailure(launcher)}`);
			continue;
		}
		const handedBack = describeHandedBackPid(launcher, { argv: [command, ...args], binaryPath: KEEPER_SCRIPT });
		if (handedBack) {
			refusals.push(`${command}: ${handedBack}`);
			continue;
		}

		const started = await awaitKeeper(path, token, launcher);
		if ('error' in started) {
			const message = `the ${state.title} failed to start: ${started.error}`;
			failAttempt(ctx, state, message, `${message} (${descriptor.binaryPath})`);
			if (started.release) await releaseClaim(ctx, descriptor, token);
			return true;
		}
		state.pid = started.pid;
		state.started = true;
		state.adopted = false;
		ctx.log.info(
			`process guard: started the ${state.title} (pid ${started.pid}) under keeper ${started.keeper}: ${descriptor.argv.join(' ')}.`
		);
		const kept = { token, keeper: started.keeper, keeperArgv: started.keeperArgv, since: Date.now() };
		// A process that has already ended is answered from its keeper's record now, rather than a poll later.
		const death = started.ended ? Promise.resolve('its keeper recorded its end') : watchPid(ctx, started.pid);
		void answerDeath(ctx, descriptor, state, restarts, death, null, process.pid, kept);
		return true;
	}

	const note =
		`the keeper for the ${state.title} could not be started (${refusals.join('; ')}), so this thread starts it ` +
		`itself and its exit is lost once this thread ends. Permit ${process.execPath} or a bare \`node\` wherever this host filters spawns.`;
	ctx.log.warn(`process guard: ${note}`);
	if (restarts === 0) ctx.report.push(note);
	return false;
}

/**
 * Wait for the keeper to commit the pid it started, or to say why it could not. `release` is whether the claim is
 * still this thread's to give back.
 *
 * @param {string} path @param {string} token @param {SpawnedChild} launcher
 * @returns {Promise<{ pid: number, keeper: number, keeperArgv: readonly string[], ended: boolean } | { error: string, release: boolean }>}
 */
async function awaitKeeper(path, token, launcher) {
	/** @type {string | null} */
	let launcherExit = null;
	const reaped = new Promise((resolve) => {
		if (typeof launcher.once !== 'function') return resolve(undefined);
		launcher.once('exit', (code, signal) => {
			launcherExit = signal ? `signal ${signal}` : `exit code ${code}`;
			resolve(undefined);
		});
	});
	// Reaped before the caller returns, so a thread ended right after the start leaves no zombie launcher.
	const reapLauncher = async () => {
		const grace = new AbortController();
		await Promise.race([reaped, delay(START_FAILURE_MS, undefined, { signal: grace.signal }).catch(() => {})]);
		grace.abort();
	};
	// Held timers throughout: a host awaiting guard() may have nothing else on its event loop.
	const deadline = Date.now() + keeperStartMs();
	for (;;) {
		const held = readLock(path);
		const record = readRecord(path);
		if (held?.token === token && held.pid > 0 && held.keeper !== undefined) {
			await reapLauncher();
			return { pid: held.pid, keeper: held.keeper, keeperArgv: held.keeperArgv ?? [], ended: false };
		}
		if (record?.token === token && record.outcome === 'failed') {
			// The lock was read first, so it can predate the keeper's own release inside the gate; `released` cannot.
			const release = record.released !== true && held?.token === token;
			return { error: record.error ?? 'its keeper gave no reason', release };
		}
		// Ended between two looks: its keeper writes the record before the lock goes, so it is here when the lock is not.
		if (record?.token === token && record.pid > 0) {
			await reapLauncher();
			return { pid: record.pid, keeper: record.keeper, keeperArgv: [], ended: true };
		}
		if (held?.token !== token)
			return { error: 'its claim was taken over before its keeper named a pid', release: false };
		const gaveUp =
			launcherExit !== null && launcherExit !== 'exit code 0'
				? `the keeper's launcher ended with ${launcherExit}`
				: Date.now() >= deadline
					? `its keeper named no pid within ${keeperStartMs()}ms`
					: null;
		if (gaveUp !== null) {
			// Given back inside the gate only while it names no pid: a keeper that committed since the look above is
			// joined, and a lock gone or taken is answered by the next look.
			/** @type {Awaited<ReturnType<typeof releaseUnstarted>>} */
			let given;
			try {
				given = await releaseUnstarted(path, token);
			} catch (error) {
				return { error: `${gaveUp}, and giving back its claim failed: ${errorMessage(error)}`, release: false };
			}
			if (given === 'gone' || given === 'taken') continue;
			if (given === 'written' || given.keeper === undefined) return { error: gaveUp, release: false };
			await reapLauncher();
			return { pid: given.pid, keeper: given.keeper, keeperArgv: given.keeperArgv ?? [], ended: false };
		}
		await delay(KEEPER_WATCH_MS);
	}
}

/** @param {{ code: number | null, signal: string | null }} record */
const causeOf = ({ code, signal }) => (signal ? `signal ${signal}` : `exit code ${code}`);

/** The fields of a state that say which pid ended and how. @param {import('./keeper.js').ExitRecord} record */
const endedBy = ({ pid, code, signal }) => ({
	...(pid > 0 ? { pid } : {}),
	code: code ?? undefined,
	signal: signal ?? undefined,
});

/**
 * The keeper's record of the death of `pid`, or null once the keeper is gone or a gate wait passes without one.
 *
 * @param {string} path @param {Kept} kept @param {number} pid
 * @returns {Promise<import('./keeper.js').ExitRecord | null>}
 */
async function keeperRecord(path, kept, pid) {
	// A crash loop overwrites the record of the death this thread saw with a later one, which still answers it.
	const matches = (/** @type {import('./keeper.js').ExitRecord | null} */ record) =>
		record?.token === kept.token && (record.pid === pid || record.at >= kept.since);
	const deadline = Date.now() + gateWaitMs();
	let checked = Date.now();
	for (;;) {
		const record = readRecord(path);
		if (matches(record)) return record;
		if (Date.now() >= deadline) return null;
		if (Date.now() - checked >= KEEPER_ALIVE_MS) {
			checked = Date.now();
			// Read once more after the keeper is found gone: it may have written on its way out.
			if (!isAlive(kept.keeper)) {
				const last = readRecord(path);
				return matches(last) ? last : null;
			}
		}
		await backoff(KEEPER_WATCH_MS);
	}
}

/**
 * Answer a death from the keeper's record of it. False leaves the death to the lock, which is how a thread
 * answers one no keeper recorded.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state
 * @param {import('./keeper.js').ExitRecord} record @param {Kept} kept @param {number} lockHost
 * @returns {Promise<boolean>}
 */
async function answerKept(ctx, descriptor, state, record, kept, lockHost) {
	const cause = causeOf(record);
	Object.assign(state, endedBy(record));
	const hint = cause.startsWith('exit code') && descriptor.exitHint ? ` ${descriptor.exitHint}` : '';
	if (record.outcome === 'released') {
		if (record.error) {
			state.error = `the ${descriptor.name} lock could not be released after a deliberate stop: ${record.error}`;
			ctx.log.error(`process guard: ${state.error}`);
		}
		ctx.log.info(`process guard: the ${state.title} (pid ${state.pid}) was shut down (${cause}); not restarting it.`);
		return true;
	}
	if (record.outcome === 'taken' && isDeliberate(cause)) {
		ctx.log.warn(
			`process guard: the ${state.title} (pid ${state.pid}) was stopped (${cause}) by whatever now holds ` +
				`the ${descriptor.name} lock, not by an operator; that thread is starting its replacement.`
		);
		return true;
	}
	if (record.outcome === 'gave-up') {
		state.error = `died ${record.restarts + 1} times (${cause}); not restarting it again`;
		ctx.log.error(
			`process guard: the ${state.title} ${state.error}. What it provided is missing from this node ` +
				`until the component reloads.${hint}`
		);
		return true;
	}
	if (record.outcome === 'failed') {
		state.error = `died (${cause}) and its keeper could not start it again: ${record.error ?? 'no reason given'}`;
		ctx.log.error(`process guard: the ${state.title} ${state.error}.${hint}`);
		return true;
	}
	if (record.outcome !== 'restarting') return false;

	ctx.log.warn(
		`process guard: the ${state.title} (pid ${state.pid}) is gone (${cause}). Its keeper starts it again in ` +
			`${record.waitMs}ms and this thread joins that (restart ${record.restarts} of ${ctx.tuning.restartMax}).${hint}`
	);
	await rejoinKept(ctx, descriptor, state, record, kept, lockHost);
	return true;
}

/**
 * Join the replacement a keeper announced, and never start one while that keeper lives: past the cap it releases
 * the lock, and a thread that claimed it then would start a second. A lock no longer the keeper's is answered by lock.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state
 * @param {import('./keeper.js').ExitRecord} record @param {Kept} kept @param {number} lockHost
 */
async function rejoinKept(ctx, descriptor, state, record, kept, lockHost) {
	const path = lockPath(ctx.pidDir, descriptor.name);
	await backoff(Math.max(0, record.at + record.waitMs - Date.now()));
	let checked = Date.now();
	for (;;) {
		if (ctx.run.stopping) return;
		let keeperGone = false;
		// Looked at before the reads below, so a keeper found gone has already written everything it will.
		if (Date.now() - checked >= KEEPER_ALIVE_MS) {
			checked = Date.now();
			keeperGone = identify(kept.keeper, kept.keeperArgv) === 'differs';
		}
		const held = readLock(path);
		const latest = readRecord(path);
		// Records are written inside the gate ahead of any release, so a lock found gone has its reason here already.
		const newer =
			latest?.token === kept.token &&
			(latest.at !== record.at || latest.pid !== record.pid || latest.outcome !== record.outcome);
		if (newer && latest) {
			if (!(await answerKept(ctx, descriptor, state, latest, kept, lockHost)))
				await answerByLock(ctx, descriptor, state, latest.restarts, causeOf(latest), null, lockHost);
			return;
		}
		if (
			held?.token === kept.token &&
			held.pid > 0 &&
			held.pid !== record.pid &&
			identifyKept(held.pid, held.argv, kept.keeper, kept.keeperArgv, held.started) === 'match'
		) {
			Object.assign(state, { pid: held.pid, restarts: record.restarts, started: true, adopted: true, exited: false });
			Object.assign(state, { error: undefined, code: undefined, signal: undefined });
			ctx.log.info(
				`process guard: the ${state.title} runs again under its keeper (pid ${held.pid}); this thread joined it.`
			);
			const again = watchPid(ctx, held.pid);
			void answerDeath(ctx, descriptor, state, record.restarts, again, null, lockHost, { ...kept, since: Date.now() });
			return;
		}
		// No deadline: a live keeper either commits or records, and a claim beside it would start a second process.
		if (held?.token !== kept.token || keeperGone) {
			// The restart the keeper announced is this thread's to answer now, counted as the same one.
			await answerByLock(ctx, descriptor, state, record.restarts - 1, causeOf(record), null, lockHost);
			return;
		}
		await backoff(KEEPER_WATCH_MS);
	}
}

/**
 * The one path for every death, whichever thread saw it: going back through the lock restarts a death
 * nobody owns and joins whatever another thread started.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state @param {number} restarts
 * @param {Promise<string>} death @param {string | null} token The owner's lock token; null when this thread only joined or a keeper holds it.
 * @param {number} lockHost Pid of the host holding the lock: this process when it owns it, and whatever the lock named when this thread joined it.
 * @param {Kept | null} kept The keeper whose record says what happened, when a keeper is the process's parent.
 */
async function answerDeath(ctx, descriptor, state, restarts, death, token, lockHost, kept) {
	const polled = await death;
	if (ctx.run.stopping) return;
	const path = lockPath(ctx.pidDir, descriptor.name);
	const record = kept ? await keeperRecord(path, kept, state.pid ?? 0) : null;
	if (ctx.run.stopping) return;
	// Only now: a status read that finds it exited must find how it ended, which the record alone may know.
	if (record) Object.assign(state, endedBy(record));
	state.exited = true;
	if (record && kept && (await answerKept(ctx, descriptor, state, record, kept, lockHost))) return;
	// An orphan's exit status reaches nobody, so this death may be a stop, and a restart would fight it.
	if (kept && !record && identify(kept.keeper, kept.keeperArgv) === 'differs') {
		state.error = `died with its keeper (pid ${kept.keeper}) gone, so nothing could read how it ended`;
		ctx.log.warn(
			`process guard: the ${state.title} (pid ${state.pid}) ${state.error}. It may have been stopped on ` +
				`purpose, so nothing starts it again until a thread calls guard().`
		);
		return;
	}
	await answerByLock(ctx, descriptor, state, restarts, record ? causeOf(record) : polled, token, lockHost);
}

/**
 * A death answered from the lock alone: release it on a deliberate stop this thread owns, leave one another
 * holder answered, and otherwise go back through it after the backoff.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state @param {number} restarts
 * @param {string} cause @param {string | null} token @param {number} lockHost
 */
async function answerByLock(ctx, descriptor, state, restarts, cause, token, lockHost) {
	const path = lockPath(ctx.pidDir, descriptor.name);
	const hint = cause.startsWith('exit code') && descriptor.exitHint ? ` ${descriptor.exitHint}` : '';

	if (token !== null && isDeliberate(cause)) {
		// This guard sends SIGTERM itself when it stops an orphan, so a signal alone cannot tell an operator
		// from a sibling thread. The lock can: another token holds it only because that thread took it first.
		const holder = readLock(path);
		if (holder !== null && holder.token !== token) {
			ctx.log.warn(
				`process guard: the ${state.title} (pid ${state.pid}) was stopped (${cause}) by whatever now holds ` +
					`the ${descriptor.name} lock, not by an operator; that thread is starting its replacement.`
			);
			return;
		}
		// The owner keeps its lock across a crash, so a joiner can tell a death nobody answered from one
		// already in hand. A deliberate stop is the one case where the lock goes.
		const releaseError = await safeLockWrite(releaseLock(path, token));
		if (releaseError) {
			state.error = `the ${descriptor.name} lock could not be released after a deliberate stop: ${releaseError}`;
			ctx.log.error(`process guard: ${state.error}`);
		}
		ctx.log.info(`process guard: the ${state.title} (pid ${state.pid}) was shut down (${cause}); not restarting it.`);
		return;
	}
	// The lock goes two ways: its holder releases it on a deliberate stop, and a reaper removes it when the
	// holder's host dies. Only that host tells them apart, and a dead one has left this death unanswered.
	if (token === null && !existsSync(path) && isAlive(lockHost)) {
		ctx.log.info(
			`process guard: the ${state.title} (pid ${state.pid}) is gone (${cause}) and its lock with it. Host ` +
				`${lockHost} held that lock and is still running, so it has answered this death; this thread is not ` +
				`starting a replacement.`
		);
		return;
	}
	if (restarts + 1 > ctx.tuning.restartMax) {
		state.error = `died ${restarts + 1} times (${cause}); not restarting it again`;
		ctx.log.error(
			`process guard: the ${state.title} ${state.error}. What it provided is missing from this node ` +
				`until the component reloads.${hint}`
		);
		return;
	}

	const wait = ctx.tuning.restartBaseMs * 2 ** restarts;
	ctx.log.warn(
		`process guard: the ${state.title} (pid ${state.pid}) is gone (${cause}). Going back through the ` +
			`lock in ${wait}ms: this thread restarts it if nothing else has, and joins it if something ` +
			`already did (attempt ${restarts + 1} of ${ctx.tuning.restartMax}).${hint}`
	);
	await backoff(wait);
	if (ctx.run.stopping) return;
	await attempt(ctx, descriptor, state, restarts + 1);
}

/**
 * Start `descriptor` if this thread wins its lock, join it if another holds it, watch it either way.
 *
 * @param {Context} ctx @param {Descriptor} descriptor
 * @returns {Promise<ProcessState>}
 */
export async function superviseProcess(ctx, descriptor) {
	/** @type {ProcessState} */
	const state = {
		name: descriptor.name,
		title: descriptor.title,
		started: false,
		adopted: false,
		exited: false,
		restarts: 0,
	};
	await attempt(ctx, descriptor, state, 0);
	return state;
}
