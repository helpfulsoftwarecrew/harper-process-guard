// What a component reads off the host and writes back, where every assertion is about a refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hostRoot, resolvePort, writeFiles } from '../../src/host.js';
import { withTempDir } from '../support/sandbox.js';

/** A log that keeps what it was told, per level. */
const recorder = () => {
	/** @type {{ info: string[], warn: string[], error: string[] }} */
	const lines = { info: [], warn: [], error: [] };
	return {
		lines,
		log: {
			info: (/** @type {string} */ m) => lines.info.push(m),
			warn: (/** @type {string} */ m) => lines.warn.push(m),
			error: (/** @type {string} */ m) => lines.error.push(m),
		},
	};
};

test('an unset variable takes the fallback and says nothing', () => {
	const { log, lines } = recorder();
	assert.equal(resolvePort('DD_X', 8126, log, 'test', {}), 8126);
	assert.equal(resolvePort('DD_X', 8126, log, 'test', { DD_X: '' }), 8126);
	assert.deepEqual(lines.warn, []);
});

test('a port in range is the number that was written', () => {
	const { log } = recorder();
	assert.equal(resolvePort('DD_X', 8126, log, 'test', { DD_X: '9000' }), 9000);
	assert.equal(resolvePort('DD_X', 8126, log, 'test', { DD_X: ' 9000 ' }), 9000);
	assert.equal(resolvePort('DD_X', 8126, log, 'test', { DD_X: '65535' }), 65535);
});

// parseInt reads "8126tcp" as 8126, which is the whole reason this is not parseInt. A silent 8126 from a
// value nobody wrote is a port the caller then renders into a config file and probes.
test('NEGATIVE: a value with a port inside it is not a port', () => {
	const { log, lines } = recorder();
	for (const raw of ['8126tcp', '81 26', '0x1fce', '9000;rm -rf /', '-1', '65536', '123456', 'default'])
		assert.equal(resolvePort('DD_X', 8126, log, 'test', { DD_X: raw }), 8126, raw);
	assert.equal(lines.warn.length, 8, JSON.stringify(lines.warn));
	assert.match(lines.warn[0] ?? '', /DD_X="8126tcp" is not a port in 1-65535/);
	assert.match(lines.warn[0] ?? '', /^test: /, 'the consumer names itself, so an operator knows who is speaking');
});

// Zero is how these processes spell "serve no endpoint", so rejecting it would turn a deliberate off back on.
test('zero is kept rather than rejected', () => {
	const { log, lines } = recorder();
	assert.equal(resolvePort('DD_X', 8126, log, 'test', { DD_X: '0' }), 0);
	assert.equal(resolvePort('DD_X', 8126, log, 'test', { DD_X: ' 0 ' }), 0);
	assert.deepEqual(lines.warn, [], 'zero is a valid answer and must not be warned about');
});

// A relative root resolves against each worker's own cwd, so two workers take different locks and each start
// their own copy of every process. Ignored, and said out loud.
test('NEGATIVE: a relative ROOTPATH is ignored, with a reason', () => {
	const { log, lines } = recorder();
	const before = process.env.ROOTPATH;
	try {
		process.env.ROOTPATH = 'relative/root';
		const root = hostRoot(log, 'test');
		assert.notEqual(root, 'relative/root');
		assert.equal(lines.warn.length, 1, JSON.stringify(lines.warn));
		assert.match(lines.warn[0] ?? '', /is not an absolute path, so it is ignored/);
		assert.match(lines.warn[0] ?? '', /different PID locks/);
	} finally {
		if (before === undefined) delete process.env.ROOTPATH;
		else process.env.ROOTPATH = before;
	}
});

test('an absolute ROOTPATH wins over the boot properties', () => {
	const { log, lines } = recorder();
	const before = process.env.ROOTPATH;
	try {
		process.env.ROOTPATH = '/absolute/root';
		assert.equal(hostRoot(log, 'test'), '/absolute/root');
		assert.deepEqual(lines.warn, []);
	} finally {
		if (before === undefined) delete process.env.ROOTPATH;
		else process.env.ROOTPATH = before;
	}
});

test('writeFiles creates the directories it needs and writes every file', () =>
	withTempDir('host-write-', async (dir) => {
		const { log, lines } = recorder();
		const one = join(dir, 'a', 'b', 'one.yaml');
		const two = join(dir, 'two.yaml');
		writeFiles({ [one]: 'first', [two]: 'second' }, log, 'test');
		assert.equal(readFileSync(one, 'utf-8'), 'first');
		assert.equal(readFileSync(two, 'utf-8'), 'second');
		assert.deepEqual(lines.error, []);
	}));

// A reader must see old or new, never half. A rename lands on a new inode where a truncating write keeps
// the old one, so the inode tells the two apart.
test('a rewrite replaces the file rather than truncating it in place', () =>
	withTempDir('host-scratch-', async (dir) => {
		const { log } = recorder();
		const target = join(dir, 'conf.yaml');
		writeFiles({ [target]: 'first body, longer' }, log, 'test');
		const first = statSync(target).ino;
		writeFiles({ [target]: 'second' }, log, 'test');
		assert.notEqual(
			statSync(target).ino,
			first,
			'the file was written in place, so a reader can see a half-written config'
		);
		assert.deepEqual(readdirSync(dir), ['conf.yaml'], 'a scratch file survived the write');
	}));

test('an existing file is replaced, not appended to', () =>
	withTempDir('host-replace-', async (dir) => {
		const { log } = recorder();
		const target = join(dir, 'conf.yaml');
		writeFileSync(target, 'old and much longer than the new one');
		writeFiles({ [target]: 'new' }, log, 'test');
		assert.equal(readFileSync(target, 'utf-8'), 'new');
	}));

// One unwritable path is not a reason to leave every other process with no config at all.
test('NEGATIVE: one unwritable target is reported and the rest are still written', () =>
	withTempDir('host-partial-', async (dir) => {
		const { log, lines } = recorder();
		const blocked = join(dir, 'blocked');
		// A file where a directory must be makes mkdirSync throw ENOTDIR, which no root-run test can bypass.
		writeFileSync(blocked, 'not a directory');
		const good = join(dir, 'good.yaml');
		writeFiles({ [join(blocked, 'conf.yaml')]: 'never', [good]: 'written' }, log, 'test');
		assert.equal(readFileSync(good, 'utf-8'), 'written', 'a later file must not be lost to an earlier failure');
		assert.equal(lines.error.length, 1, JSON.stringify(lines.error));
		assert.match(lines.error[0] ?? '', /could not write/);
		assert.ok((lines.error[0] ?? '').includes(blocked), 'the message must name the path that failed');
		assert.ok(!existsSync(join(blocked, 'conf.yaml')));
	}));
