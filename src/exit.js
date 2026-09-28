// @ts-check
// Was that a shutdown or a crash. supervise.js restarts from this and a consumer's status describes a death
// from it, so the two cannot disagree about the same signal.

import { constants } from 'node:os';

/** @param {unknown} error @returns {string | undefined} */
export function errnoCode(error) {
	return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** @param {unknown} error @returns {string} */
export function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

// Signals a supervisor sends on the way down. Anything else is a crash or an OOM kill, and a Go process with
// no handler exits with no code at all either way.
const SHUTDOWN_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP']);

const SPAWN_FAILURES = {
	// X_OK passes for a binary built for another architecture, so this is the one cause no preflight sees.
	ENOEXEC: (/** @type {string} */ path) =>
		`${path} is not executable code for this machine (ENOEXEC). A binary built for another ` +
		`architecture produces exactly this; check with \`file ${path}\`.`,
	EACCES: (/** @type {string} */ path) =>
		`${path} is not executable by this user (EACCES). Check the file mode, ` +
		`then every directory on the path to it, then whether the volume is mounted noexec.`,
	ENOENT: (/** @type {string} */ path) =>
		`${path} does not exist (ENOENT). The platform package resolved a path ` +
		`and nothing is at it, so the package installed without its binary.`,
};

/**
 * Why a spawn was refused. Falls back to the thrown message, which is what a host's own refusal carries:
 * Harper rejects an unlisted command in its own words and this must not overwrite them.
 *
 * @param {unknown} error @param {string} binaryPath
 */
export function describeSpawnFailure(error, binaryPath) {
	const code = errnoCode(error);
	const known =
		code === undefined ? undefined : /** @type {Record<string, (p: string) => string>} */ (SPAWN_FAILURES)[code];
	if (known) return known(binaryPath);
	return errorMessage(error);
}

/**
 * How a child ended. A signalled process reports code `null`, which reads as a clean stop everywhere
 * `code || 0` is written, and `deliberate` is the only answer here to whether a restart would fight anyone.
 *
 * @param {number | null} code @param {NodeJS.Signals | string | null} signal
 * @returns {{ killed: boolean, deliberate: boolean, detail: string, exitCode: number }}
 */
export function describeExit(code, signal) {
	if (signal) {
		const number = /** @type {Record<string, number>} */ (constants.signals)[signal] ?? 0;
		if (SHUTDOWN_SIGNALS.has(signal)) {
			return { killed: false, deliberate: true, detail: `terminated by ${signal}`, exitCode: 128 + number };
		}
		return {
			killed: true,
			deliberate: false,
			detail: `killed by ${signal}, which is a crash or an OOM kill rather than a shutdown`,
			exitCode: 128 + number,
		};
	}
	if (code === 0) return { killed: false, deliberate: true, detail: 'exited cleanly', exitCode: 0 };
	return { killed: false, deliberate: false, detail: `exited with code ${code}`, exitCode: code ?? 1 };
}

/**
 * Whether an exit cause string names a deliberate stop, read back through describeExit rather than against a
 * second list of the same signals.
 *
 * @param {string} cause
 */
export function isDeliberate(cause) {
	const signal = /^signal (.+)$/.exec(cause);
	if (signal) return describeExit(null, signal[1] ?? null).deliberate;
	const code = /^exit code (-?\d+)$/.exec(cause);
	if (code) return describeExit(Number(code[1]), null).deliberate;
	return false;
}
