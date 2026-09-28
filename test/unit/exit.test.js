// Restarting into a deliberate stop fights the operator, so what counts as deliberate is decided here once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:os';

import { describeExit, describeSpawnFailure, isDeliberate } from '../../src/exit.js';

test('a shutdown signal is deliberate and is not a kill', () => {
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
		const exit = describeExit(null, signal);
		assert.equal(exit.deliberate, true, signal);
		assert.equal(exit.killed, false, signal);
		assert.match(exit.detail, new RegExp(`terminated by ${signal}`));
	}
});

// The distinction the whole file exists for: SIGKILL is what an OOM kill looks like, and restarting into
// it is correct where restarting into SIGTERM is not.
test('NEGATIVE: a signal nobody sends on the way down is a kill, not a shutdown', () => {
	const exit = describeExit(null, 'SIGKILL');
	assert.equal(exit.deliberate, false);
	assert.equal(exit.killed, true);
	assert.match(exit.detail, /crash or an OOM kill/);
});

test('a zero exit is deliberate; any other code is not', () => {
	assert.equal(describeExit(0, null).deliberate, true);
	assert.equal(describeExit(1, null).deliberate, false);
	assert.equal(describeExit(137, null).deliberate, false);
});

// A signalled process reports code null, which reads as a clean stop everywhere `code || 0` is written.
test('a signalled process does not report a zero exit code', () => {
	const exit = describeExit(null, 'SIGKILL');
	assert.equal(exit.exitCode, 128 + (constants.signals.SIGKILL ?? 0));
	assert.notEqual(exit.exitCode, 0);
});

// The whole shape, not just the flag: a consumer's status endpoint prints `detail` and a host reads `exitCode`,
// so both are contract rather than internal.
test('a clean exit reports every field a consumer publishes', () => {
	assert.deepEqual(describeExit(0, null), {
		killed: false,
		deliberate: true,
		detail: 'exited cleanly',
		exitCode: 0,
	});
	assert.equal(describeExit(2, null).exitCode, 2, 'a real exit code must survive to whoever reads it');
});

// supervise.js builds these strings for its log lines, and reads them back to decide on a restart. If the
// two encodings drift, the guard restarts something an operator stopped.
test('the cause strings supervise.js builds read back to the same verdict', () => {
	/** @type {Array<[number | null, string | null]>} */
	const pairs = [
		[0, null],
		[1, null],
		[null, 'SIGTERM'],
		[null, 'SIGKILL'],
	];
	for (const [code, signal] of pairs) {
		const cause = signal ? `signal ${signal}` : `exit code ${code}`;
		assert.equal(isDeliberate(cause), describeExit(code, signal).deliberate, cause);
	}
});

test('NEGATIVE: a cause string in neither shape is not deliberate', () => {
	for (const cause of ['', 'who knows', 'exit code', 'signal'])
		assert.equal(isDeliberate(cause), false, JSON.stringify(cause));
});

// X_OK passes for a binary built for another architecture, so this is the one cause no preflight catches.
test('each spawn refusal names what actually happened', () => {
	/** @type {Array<[string, RegExp]>} */
	const cases = [
		['ENOEXEC', /not executable code for this machine/],
		['EACCES', /not executable by this user/],
		['ENOENT', /does not exist/],
	];
	for (const [code, expected] of cases) {
		const error = Object.assign(new Error('spawn failed'), { code });
		const described = describeSpawnFailure(error, '/bin/thing');
		assert.match(described, expected, code);
		assert.match(described, /\/bin\/thing/, code);
	}
});

// A host's own refusal carries its own wording. Harper rejects an unlisted command with a message naming
// the allowlist, and overwriting that with a guess about the file would send an operator to the wrong fix.
test('NEGATIVE: an error with no known code keeps its own message', () => {
	assert.equal(describeSpawnFailure(new Error('Command /x is not allowed'), '/x'), 'Command /x is not allowed');
	assert.equal(describeSpawnFailure('a string', '/x'), 'a string');
});
