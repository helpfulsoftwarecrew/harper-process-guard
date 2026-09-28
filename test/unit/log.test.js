// Harper's Logger declares every method optional, and guard() logs unguarded after it commits a lock, so a
// host implementing one level would throw from a path that already owns a process.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseLog } from '../../src/host.js';

/** @param {...string} methods @returns {{ host: Record<string, any>, seen: string[][] }} */
const recorder = (...methods) => {
	/** @type {string[][]} */
	const seen = [];
	/** @type {Record<string, any>} */
	const host = {};
	for (const name of methods) host[name] = (/** @type {string} */ message) => seen.push([name, message]);
	return { host, seen };
};

test('a host with all three levels is used as it stands', () => {
	const { host, seen } = recorder('info', 'warn', 'error');
	const log = normaliseLog(host);
	log.info('i');
	log.warn('w');
	log.error('e');
	assert.deepEqual(seen, [
		['info', 'i'],
		['warn', 'w'],
		['error', 'e'],
	]);
});

// The case that throws without this: the guard calls log.info on a host that has only warn.
test('NEGATIVE: a level the host lacks is not a call on undefined', () => {
	const { host, seen } = recorder('warn');
	const log = normaliseLog(host);
	log.info('routed');
	log.error('routed too');
	assert.deepEqual(seen, [
		['warn', 'routed'],
		['warn', 'routed too'],
	]);
});

// Falling back must not lose the message. A logger that dropped info on a warn-only host would hide the
// line that says which process was adopted.
test('no message is dropped for want of a method', () => {
	const log = normaliseLog(/** @type {any} */ ({}));
	// An empty host has nothing to route to, so console.log is the floor rather than silence.
	assert.doesNotThrow(() => log.info('x'));
	assert.doesNotThrow(() => log.warn('x'));
	assert.doesNotThrow(() => log.error('x'));
});

// Harper's logger reads `this`, so an unbound method loses its channel.
test('the host is the receiver, not the adapter', () => {
	const host = {
		channel: 'harper',
		/** @type {string[]} */
		seen: [],
		/** @param {string} message */
		warn(message) {
			this.seen.push(`${this.channel}:${message}`);
		},
	};
	normaliseLog(host).warn('bound');
	assert.deepEqual(host.seen, ['harper:bound']);
});

test('no host at all is console-shaped rather than a throw', () => {
	assert.doesNotThrow(() => normaliseLog().info('no host'));
});

// A property that is present but not callable is the shape a proxy-based logger can present.
test('NEGATIVE: a non-function property is not treated as a method', () => {
	// Each level tries itself, then the next most severe, so a string at .info is stepped over, not called.
	const { host, seen } = recorder('warn');
	host.info = 'not a function';
	normaliseLog(host).info('falls past it');
	assert.deepEqual(seen, [['warn', 'falls past it']]);
});
