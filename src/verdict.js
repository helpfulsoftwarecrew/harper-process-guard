// @ts-check
// When a proof stops describing the process that is running. The supervisor rewrites `pid` on the same state
// object for the life of the node, so a verdict taken at boot outlives what it proved.

/** True once the process a verdict describes has been replaced. One taken against no pid cannot go stale. */
const staleVerdict = (/** @type {any} */ state) =>
	typeof state?.verifiedPid === 'number' && state.verifiedPid !== state.pid;

/**
 * Record which pid the verdict about to be taken is about, before the proof runs: it polls, and the pid can
 * be replaced while it does.
 *
 * @param {Record<string, any>} state
 */
export function takeVerdictAgainst(state) {
	state.verifiedPid = state.pid ?? null;
	return state;
}

/**
 * The verdict for a process this thread never started, or null when it did. Strictly false, because a
 * supervisor reporting no `started` field at all does have a process.
 *
 * @param {Record<string, any>} state
 */
export const neverStarted = (state) =>
	state?.started === false
		? {
				ok: false,
				detail:
					`this node never started it${state.error ? `: ${state.error}` : ''}, so nothing was polled and ` +
					`anything answering its port belongs to another process`,
			}
		: null;

/**
 * The verdict as it stands now, read at the endpoint rather than stamped at boot.
 *
 * @param {Record<string, any>} state
 */
export const currentVerdict = (state) => {
	if (!staleVerdict(state)) return state;
	// Only when the host kept a count: `restarts` is this package's own field, which a host supervising
	// natively may not set, and the sentence has to stand without it.
	const times = typeof state.restarts === 'number' ? ` ${state.restarts} time(s)` : '';
	return {
		...state,
		verified: null,
		verifyDetail:
			`the last verdict was taken against pid ${state.verifiedPid}, which this node has since ` +
			`restarted${times} as pid ${state.pid}. Nothing has verified the process now ` +
			`running; what the dead one proved was: ${state.verifyDetail}`,
	};
};

/**
 * How long a refuted verdict stands before the read path asks again. A retake costs the consumer a probe, and
 * a process that is really down would otherwise make every status request pay one.
 */
export const RETAKE_INTERVAL_MS = 10_000;

/**
 * Why the verdict on `state` is being retaken, or null when it stands as it is.
 *
 * @param {Record<string, any>} state @param {number} now @param {number} intervalMs
 * @returns {'restarted' | 'untaken' | 'refuted' | null}
 */
function retakeReason(state, now, intervalMs) {
	// A process this thread never started has no proof to retake; anything answering its port is a stranger.
	if (state?.started === false) return null;
	// Nor one that has exited: a probe then polls something that is not running, and its verdict would outlive it.
	if (state?.exited === true) return null;
	if (staleVerdict(state)) return 'restarted';
	// A thread whose own spawn was refused carries the node's process and no verdict, and publishing
	// "unverified" for that is the refusal masquerading as health.
	if (state?.started === true && state?.verified === undefined) return 'untaken';
	// A proof of health stands while the pid it proved does. A proof of failure is usually a boot race, such
	// as a poll of a socket another process creates seconds later, so it is asked again after an interval.
	const asked = state?.verifiedAt;
	if (state?.verified !== false) return null;
	if (typeof asked !== 'number') return 'refuted';
	// `verifiedAt` is a wall clock that a correction can put in the future, where the interval would never
	// elapse; a negative elapsed time retakes instead, since one extra probe is the direction to fail in.
	const elapsed = now - asked;
	return elapsed < 0 || elapsed >= intervalMs ? 'refuted' : null;
}

/**
 * Retake a verdict that no longer describes the running process, where currentVerdict alone would answer
 * `verified: null` for the life of the node. `reason` goes to the proof, which alone knows what a probe costs.
 *
 * @param {Record<string, any>} state
 * @param {(state: any, context?: {reason: string}) => Promise<{ok: boolean, detail: string}>} [verify]
 * @param {{now?: () => number, intervalMs?: number}} [options]
 */
export async function retakeVerdict(state, verify, { now = Date.now, intervalMs = RETAKE_INTERVAL_MS } = {}) {
	const reason = retakeReason(state, now(), intervalMs);
	if (!verify || reason === null) return currentVerdict(state);
	// Onto the supervisor's own object, the way the first verdict is: a copy would serve the old detail beside the new pid.
	try {
		const { ok, detail } = await verify(state, { reason });
		state.verified = ok;
		state.verifyDetail = detail;
	} catch (error) {
		state.verified = false;
		state.verifyDetail = `retaking the verdict against pid ${state.pid} threw: ${error instanceof Error ? error.message : String(error)}`;
	}
	// After the proof, not before: the interval is between answers, and a proof that waits out its own budget
	// would otherwise be re-entered by every request that arrived while it ran.
	state.verifiedAt = now();
	return state;
}
