// Polling a process that has not bound its port yet, against real servers and sockets, because the subject
// is how node's http client and net socket behave at the edges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJson, pollEndpoint, pollUnixSocket, tailFile, untraceWith } from '../../src/probe.js';
import { createStallingTlsStub, createTlsStub } from '../support/tls-stub.js';
import { findFreePort, withPatchedSetTimeout, withServer, withTempDir } from '../support/sandbox.js';

/**
 * An http server on a loopback port for the test's duration, addressed by base URL.
 *
 * @param {import('node:http').RequestListener} handler @param {(base: string) => Promise<any>} run
 */
const withHttp = (handler, run) => withServer(createServer(handler), (port) => run(`http://127.0.0.1:${port}`));

/** The sleeps a poll asks for, read off the clock rather than waited out. */
async function recordedWaits(/** @type {any} */ options, /** @type {number} */ stopAfter) {
	/** @type {number[]} */
	const waits = [];
	let armed = false;
	await withPatchedSetTimeout(
		// Nothing awaits between giveUp returning and the backoff's setTimeout, so the first setTimeout after a
		// giveUp is always the backoff and never some other library's timer.
		(realSetTimeout) =>
			(/** @type {any} */ callback, /** @type {number} */ ms, /** @type {any[]} */ ...rest) => {
				if (!armed) return realSetTimeout(callback, ms, ...rest);
				armed = false;
				waits.push(ms);
				return realSetTimeout(callback, 0, ...rest);
			},
		() =>
			pollEndpoint({
				...options,
				giveUp: () => {
					armed = true;
					return waits.length >= stopAfter;
				},
			})
	);
	return waits;
}

/**
 * 503s the first `failures` probes, then serves. 503 rather than a refused connection: a listener started
 * mid-test races the poll it is meant to outlast.
 *
 * @param {number} failures
 */
function failsThenServes(failures) {
	let served = 0;
	return createServer((_request, response) => {
		const ready = ++served > failures;
		response.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
		response.end(ready ? 'expvar' : 'not yet');
	});
}

test('parseJson answers null for everything that is not JSON, and never throws', () => {
	assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
	for (const body of [null, '', 'not json', '<html>503</html>', '{"a":'])
		assert.equal(parseJson(body), null, String(body));
});

test('a body is returned once something answers', () =>
	withHttp(
		(_request, response) => response.end('{"pid":42}'),
		async (base) => {
			assert.equal(await pollEndpoint({ url: `${base}/debug/vars`, timeoutMs: 2000 }), '{"pid":42}');
		}
	));

// A process that is up but serving an error page is not one this node can use, and a 404 body parsed as a
// verdict would read as one that answered.
test('NEGATIVE: a non-2xx answer is not an answer', () =>
	withHttp(
		(_request, response) => {
			response.statusCode = 404;
			response.end('not here');
		},
		async (base) => {
			assert.equal(await pollEndpoint({ url: `${base}/nope`, timeoutMs: 300, intervalMs: 50 }), null);
		}
	));

test('nothing listening reads as null rather than throwing', async () => {
	// Port 1 on loopback: refused immediately and never bindable by an unprivileged test.
	assert.equal(await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 300, intervalMs: 50 }), null);
});

// The giveUp is how a dead process stops the poll early: nothing it binds will ever answer, and the caller
// would otherwise spend its whole deadline asking.
test('giveUp stops the poll before the deadline', async () => {
	const started = Date.now();
	assert.equal(
		await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 10_000, intervalMs: 50, giveUp: () => true }),
		null
	);
	assert.ok(Date.now() - started < 5000, `the poll ran for ${Date.now() - started}ms despite giveUp`);
});

// Asked only after a probe has failed, so a target that answered and then died still reports what it said.
test('giveUp is not asked before the first probe', () =>
	withHttp(
		(_request, response) => response.end('answered'),
		async (base) => {
			let asked = 0;
			const body = await pollEndpoint({
				url: `${base}/`,
				timeoutMs: 2000,
				giveUp: () => {
					asked++;
					return true;
				},
			});
			assert.equal(body, 'answered');
			assert.equal(asked, 0, 'a target that answers must not be abandoned for a giveUp that was true');
		}
	));

// A response that starts and then stalls never trips the socket's own inactivity timeout, and the whole poll
// hangs behind it.
test('NEGATIVE: a stalled response is abandoned on the deadline', () =>
	withHttp(
		(_request, response) => {
			response.writeHead(200);
			response.write('half');
			// Never ended: the request completes and the body never finishes arriving.
		},
		async (base) => {
			// Raced against a timer because the failure is a promise that never settles, which timing alone hangs on.
			const answer = await Promise.race([
				pollEndpoint({ url: `${base}/`, timeoutMs: 2500, intervalMs: 100 }),
				new Promise((resolve) => setTimeout(() => resolve('HUNG'), 8000).unref?.()),
			]);
			assert.equal(answer, null, 'the poll never came back: nothing bounds a response that stalls mid-body');
		}
	));

// Windows has no AF_UNIX socket at a filesystem path; a process there listens on a named pipe, which node's
// net client dials through the same call.
const socketAddress = (/** @type {string} */ dir, /** @type {string} */ name) =>
	process.platform === 'win32' ? `\\\\.\\pipe\\${name}-${process.pid}` : join(dir, `${name}.sock`);

test('a socket that accepts is an answer', () =>
	withTempDir('probe-sock-', async (dir) => {
		const path = socketAddress(dir, 'probe');
		const server = createSocketServer((socket) => socket.end());
		await new Promise((resolve) => server.listen(path, () => resolve(undefined)));
		try {
			assert.equal(await pollUnixSocket({ path, timeoutMs: 2000 }), true);
		} finally {
			await new Promise((resolve) => server.close(() => resolve(undefined)));
		}
	}));

test('NEGATIVE: a missing socket, and a path that is a plain file, both read as false', () =>
	withTempDir('probe-nosock-', async (dir) => {
		const absent = socketAddress(dir, 'absent');
		assert.equal(await pollUnixSocket({ path: absent, timeoutMs: 250, intervalMs: 50 }), false);
		const file = join(dir, 'plain');
		writeFileSync(file, 'not a socket');
		assert.equal(await pollUnixSocket({ path: file, timeoutMs: 250, intervalMs: 50 }), false);
	}));

// The reason this hook exists: without it every failed connect during a startup poll becomes an errored client
// span on the host application's own service.
test('the wrapper is what every probe runs inside', async () => {
	let inside = 0;
	untraceWith((run) => {
		inside++;
		return run();
	});
	try {
		await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 200, intervalMs: 50 });
		const afterHttp = inside;
		assert.ok(afterHttp > 0, 'the HTTP probe was made outside the wrapper');
		await pollUnixSocket({ path: '/nonexistent/probe.sock', timeoutMs: 200, intervalMs: 50 });
		assert.ok(inside > afterHttp, 'the socket probe was made outside the wrapper');
	} finally {
		untraceWith((run) => run());
	}
});

// A consumer's wrapper reaches into a tracer's private path, and the never-throws contract has to hold when
// that path moves.
test('NEGATIVE: a wrapper that throws does not break the never-throws contract', async () => {
	untraceWith(() => {
		throw new Error('the private path moved');
	});
	try {
		assert.equal(await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 200, intervalMs: 50 }), null);
	} finally {
		untraceWith((run) => run());
	}
});

test('tailFile returns the end of the file, bounded', () =>
	withTempDir('probe-tail-', async (dir) => {
		const file = join(dir, 'agent.log');
		writeFileSync(file, '');
		for (let line = 0; line < 500; line++) appendFileSync(file, `line ${line} padded out to some width\n`);
		const tail = tailFile(file, 1024);
		assert.ok(tail !== null);
		assert.ok(tail.length <= 1024, `read ${tail.length} bytes for a 1024 budget`);
		assert.match(tail, /line 499/, 'the end of the file is the part worth reading');
		assert.doesNotMatch(tail, /line 0 /, 'the whole file was read despite the budget');
	}));

// These files roll at megabytes and a status read cannot afford the whole of one, so the budget has to hold
// even when the file is far bigger than it.
test('tailFile reads no more than the budget from a file much larger than it', () =>
	withTempDir('probe-big-', async (dir) => {
		const file = join(dir, 'big.log');
		writeFileSync(file, 'x'.repeat(200_000));
		assert.equal(tailFile(file, 4096)?.length, 4096);
	}));

test('a file smaller than the budget comes back whole', () =>
	withTempDir('probe-small-', async (dir) => {
		const file = join(dir, 'small.log');
		writeFileSync(file, 'short');
		assert.equal(tailFile(file, 4096), 'short');
	}));

test('NEGATIVE: a file that cannot be read at all is null, not an empty tail', () =>
	withTempDir('probe-none-', async (dir) => {
		assert.equal(tailFile(join(dir, 'absent.log')), null);
		assert.equal(tailFile(dir), null, 'a directory is not a log');
	}));

// Every worker thread polls a port that binds seconds after spawn, and under a tracer each failed probe is a
// span, so a fixed short interval multiplies them.
test('NEGATIVE: the poll does not retry at a fixed interval; it doubles and then caps', async () => {
	// Nothing is listening, so every probe fails the way a pre-bind port does.
	const port = await findFreePort();
	const waits = await recordedWaits({ url: `http://127.0.0.1:${port}/debug/vars` }, 8);

	// Probes land at 0, 250, 750, 1750, 3750 and 7750ms, against one every 250ms at a flat interval.
	assert.deepEqual(
		waits,
		[250, 500, 1000, 2000, 4000, 5000, 5000, 5000],
		'the backoff must double from intervalMs and then cap, or a target that binds late costs one probe every 250ms until it does'
	);
});

test('the deadline still bounds the poll: the last wait is truncated, not overrun', async () => {
	// Real time, since the clamp-versus-backoff race is what a mocked setTimeout cannot reproduce.
	const port = await findFreePort();
	const started = Date.now();
	const body = await pollEndpoint({ url: `http://127.0.0.1:${port}/debug/vars`, timeoutMs: 300, intervalMs: 200 });
	const elapsed = Date.now() - started;

	assert.equal(body, null, 'nothing was listening, so the deadline had to win');
	assert.ok(elapsed >= 260, `gave up after ${elapsed}ms, short of the 300ms deadline it was given`);
	// Unclamped, the second wait doubles to 400ms and the poll lands around 600ms.
	assert.ok(elapsed < 550, `ran ${elapsed}ms against a 300ms deadline: the backoff is sleeping past it`);
});

// The whole point of the backoff: two failures then a serve has to come back with the body, not with the null
// a caller would read as "nothing is there".
test('a poll that had to wait still returns the body it waited for', async () => {
	const body = await withServer(failsThenServes(2), (port) =>
		pollEndpoint({ url: `http://127.0.0.1:${port}/debug/vars`, intervalMs: 20 })
	);
	assert.equal(body, 'expvar', 'a poll that retried past two 503s dropped the body the third probe returned');
});

// A consumer's never-rejects contract rests on this one, and the probe runs inside a wrapper that can reach
// into a tracer's private path and move under it.
test('NEGATIVE: a request the client refuses outright answers null rather than rejecting', async () => {
	const answered = await pollEndpoint({
		// A port outside 1-65535 is not a URL, so node:https throws before it ever opens a socket.
		url: 'https://127.0.0.1:99999/debug/vars',
		giveUp: () => true,
	});
	assert.equal(
		answered,
		null,
		'a request the https client refused outright rejected out of a poll documented never to throw'
	);
});

// The half of this module a process behind a self-signed certificate is read through. Nothing else here dials
// TLS, so without it every TLS assertion could pass against a client that can only ever answer null.
test('the probe reads a body back off a real TLS endpoint', async () => {
	const body = await withServer(createTlsStub({ body: { pid: '4321' } }), (port) =>
		pollEndpoint({ url: `https://127.0.0.1:${port}/debug/vars`, giveUp: () => true })
	);
	assert.equal(parseJson(body)?.pid, '4321', `the probe answered ${body} for a body a plain curl reads back whole`);
});

// The timeout destroys the socket after the request has finished, so the reset lands on the response, and a
// listener on the request alone leaves every status read that polls here hanging.
test('NEGATIVE: a TLS response that starts and then stalls settles rather than hanging its caller', async () => {
	/** @type {any[]} */
	const held = [];
	const settled = await withServer(createStallingTlsStub(held), async (port) => {
		const answered = await Promise.race([
			pollEndpoint({ url: `https://127.0.0.1:${port}/debug/vars`, timeoutMs: 2000, giveUp: () => true }).then(
				() => 'settled'
			),
			new Promise((resolve) => setTimeout(() => resolve('still pending'), 8000).unref?.()),
		]);
		// The held responses must end here, or the server cannot close and teardown never finishes.
		held.forEach((response) => response.end('null}'));
		return answered;
	});

	assert.equal(
		settled,
		'settled',
		'a probe against a stalled response never came back, so every status read after it hangs too'
	);
	assert.equal(held.length, 1, 'the stub was supposed to be dialled exactly once');
});
