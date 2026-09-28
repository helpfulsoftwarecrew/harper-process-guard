// @ts-check
// Whether anything is answering yet. A process binds seconds after its spawn returns, so everything here
// polls with a doubling backoff, never throws, and stops early on a dead process.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const PROBE_TIMEOUT_MS = 1000;
const MAX_INTERVAL_MS = 5_000;

/** @type {(run: () => any) => any} */
let wrap = (run) => run();

/**
 * Make every probe run inside `fn`. Module-global because a tracer's suppression is process-wide, so no
 * second component can want a different answer; unset, requests are made directly.
 *
 * @param {(run: () => any) => any} fn
 */
export function untraceWith(fn) {
	wrap = fn;
}

/**
 * A probe body as JSON, or null. Never throws: these come off a socket, and that is the pollers' contract.
 *
 * @param {string | null} body
 */
export function parseJson(body) {
	try {
		return body === null ? null : JSON.parse(body);
	} catch {
		return null;
	}
}

/**
 * GET over http or https accepting a self-signed certificate, loopback only. Global fetch cannot stand in:
 * Node exposes no public dispatcher for that certificate.
 *
 * @param {string} url @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
function get(url, timeoutMs) {
	return new Promise((resolve) => {
		/** @type {any} */
		let deadline;
		/** @param {string | null} body */
		const settle = (body) => {
			clearTimeout(deadline);
			resolve(body);
		};
		// node:http ignores rejectUnauthorized, so the scheme is the only difference between the two probes.
		const send = url.startsWith('https:') ? httpsRequest : httpRequest;
		const call = send(url, { rejectUnauthorized: false }, (response) => {
			const status = response.statusCode;
			if (status === undefined || status < 200 || status >= 300) {
				response.resume();
				settle(null);
				return;
			}
			let body = '';
			response.setEncoding('utf-8');
			response.on('data', (chunk) => (body += chunk));
			response.on('end', () => settle(body));
			// A destroy()'s reset lands here rather than on the request; unheard, it leaves this pending.
			response.on('error', () => settle(null));
		});
		call.on('error', () => settle(null));
		// One deadline over the whole exchange: a response that starts then stalls never trips an
		// inactivity timeout.
		deadline = setTimeout(() => {
			call.destroy();
			settle(null);
		}, timeoutMs);
		call.end();
	});
}

// Under the wrapper: the span is created where the request is, which is the only place suppression cannot
// be undone by other code in the process.
/** @param {string} url @param {number} timeoutMs @returns {Promise<string | null>} */
async function probe(url, timeoutMs) {
	try {
		// Awaited inside the try: the wrapper is a consumer's function reaching into a tracer's private path,
		// and never-throws has to hold when that path moves.
		return await wrap(() => get(url, timeoutMs));
	} catch {
		return null;
	}
}

/**
 * Whether anything accepts on a unix socket. A connect and an immediate close, because the question is
 * whether it listens and a bare accept answers that without knowing a route that could move.
 *
 * @param {string} path @param {number} timeoutMs
 */
function probeSocket(path, timeoutMs) {
	return new Promise((resolve) => {
		/** @type {any} */
		let deadline;
		/** @param {boolean} answered */
		const settle = (answered) => {
			clearTimeout(deadline);
			socket.destroy();
			resolve(answered);
		};
		const socket = connect(path);
		socket.on('connect', () => settle(true));
		socket.on('error', () => settle(false));
		deadline = setTimeout(() => settle(false), timeoutMs);
	});
}

/**
 * {@link pollEndpoint} against a unix socket, for a process that serves one instead of a loopback port.
 *
 * @param {{ path: string, timeoutMs?: number, intervalMs?: number, giveUp?: () => boolean }} options
 */
export async function pollUnixSocket({ path, timeoutMs = 30_000, intervalMs = 250, giveUp }) {
	const deadline = Date.now() + timeoutMs;
	let interval = intervalMs;
	for (;;) {
		const budget = Math.min(PROBE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1));
		// Untraced for the same reason as the HTTP probes: a failed connect would become an errored client
		// span on the host application's own service.
		const answered = await wrap(() => probeSocket(path, budget)).catch(() => false);
		if (answered) return true;
		if (giveUp?.() || Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
		interval = Math.min(interval * 2, MAX_INTERVAL_MS);
	}
}

/**
 * GET until something answers: the body text, or null on deadline or giveUp(). Never throws.
 *
 * @param {{ url: string, timeoutMs?: number, intervalMs?: number, giveUp?: () => boolean }} options
 */
export async function pollEndpoint({ url, timeoutMs = 30_000, intervalMs = 250, giveUp }) {
	const deadline = Date.now() + timeoutMs;
	let interval = intervalMs;
	for (;;) {
		const budget = Math.min(PROBE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1));
		const body = await probe(url, budget);
		if (body !== null) return body;
		// Between probes and only after one failed, so a target that answered then died still counts.
		if (giveUp?.() || Date.now() >= deadline) return null;
		// Clamped: backing off must not spend the caller's budget asleep past the deadline.
		await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
		interval = Math.min(interval * 2, MAX_INTERVAL_MS);
	}
}

/**
 * The last bytes of a file, or null when it cannot be read. A process's own log is the evidence of last
 * resort, and bounded from the end because these roll at megabytes and a status read cannot afford one.
 *
 * @param {string} file @param {number} [maxBytes]
 * @returns {string | null}
 */
export function tailFile(file, maxBytes = 64 * 1024) {
	try {
		const stats = statSync(file);
		// A directory reads back zero bytes on Windows, answering "" and claiming the log is empty. That is
		// a different claim from "nothing could be read", and a caller acts on it.
		if (!stats.isFile()) return null;
		const { size } = stats;
		const start = Math.max(0, size - maxBytes);
		const handle = openSync(file, 'r');
		try {
			const buffer = Buffer.alloc(Math.min(maxBytes, size - start));
			readSync(handle, buffer, 0, buffer.length, start);
			return buffer.toString('utf-8');
		} finally {
			closeSync(handle);
		}
	} catch {
		return null;
	}
}
