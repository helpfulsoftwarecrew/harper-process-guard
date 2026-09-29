// @ts-check
// What a thread does once the lock is settled. A thread that only joined still watches and still answers
// a death, because reporting success and then supervising nothing is the defect, joined or started.
import { accessSync, constants, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { argvOf, compareArgv, isAlive } from './identity.js';
// Which exits mean somebody shut it down lives in exit.js, so this file and a consumer's status endpoint
// cannot disagree about the same signal. Restarting into one of these fights the operator.
import { describeSpawnFailure, errorMessage, isDeliberate } from './exit.js';
import { claimLock, commitLock, lockPath, readLock, releaseLock, safeLockWrite, START_FAILURE_MS } from './lock.js';

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
 * @property {boolean} adopted True when this thread joined a process another thread started.
 * @property {boolean} exited True once this thread has seen it die, so a status surface stops reading healthy.
 * @property {number} restarts
 * @property {string | undefined} [error]
 * @property {boolean} [verified] Set from the caller's verify().
 * @property {string | undefined} [verifyDetail]
 * @property {number | undefined} [code] Exit code of a child this thread spawned. Unset for a joined process.
 * @property {string | undefined} [signal] Signal that killed a child this thread spawned. Unset for a joined process.
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
 */

/** Unref'd so nothing here holds the host open; outliving the host is the reaper's job. @param {number} ms */
const backoff = (ms) => delay(ms, undefined, { ref: false });

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
		void answerDeath(ctx, descriptor, state, restarts, watchPid(ctx, claim.pid), null, holder?.host ?? 0);
		return;
	}

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

	// A second 'exit' listener alongside watchChild's own; Node fires both. This is the only place
	// state.code and state.signal are ever set, since a joined process has no child to ask.
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
	void answerDeath(ctx, descriptor, state, restarts, death, claim.token, process.pid);
}

/**
 * The one path for every death, whichever thread saw it: going back through the lock restarts a death
 * nobody owns and joins whatever another thread started.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state @param {number} restarts
 * @param {Promise<string>} death @param {string | null} token The owner's lock token; null when this thread only joined.
 * @param {number} lockHost Pid of the host holding the lock: this process when it owns it, and whatever the lock named when this thread joined it.
 */
async function answerDeath(ctx, descriptor, state, restarts, death, token, lockHost) {
	const cause = await death;
	if (ctx.run.stopping) return;
	state.exited = true;
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
