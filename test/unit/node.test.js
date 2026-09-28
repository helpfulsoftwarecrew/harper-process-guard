// The node rather than the thread: a component that works in one thread multiplies or forgets the moment
// Harper runs it in eight.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { claimSingleton, claimStaleMs, readProcess, selfProcess, sharedMarks } from '../../src/node.js';
import { withTempDir } from '../support/sandbox.js';

test('a mark written by one store is read by another over the same directory', () =>
	withTempDir('node-marks-', async (dir) => {
		const writer = sharedMarks(dir, 'stats');
		const reader = sharedMarks(dir, 'stats');
		assert.equal(reader.get('one'), undefined, 'nothing has been written yet');
		writer.set('one', 1_757_000_000_000);
		assert.equal(reader.get('one'), 1_757_000_000_000);
	}));

// Module memory is per thread, so a second reader sees nothing, and a verdict computed from that is wrong.
test('NEGATIVE: two module-memory stores do not see each other', () => {
	const one = sharedMarks(undefined, 'stats');
	const two = sharedMarks(undefined, 'stats');
	one.set('key', 5);
	assert.equal(one.get('key'), 5, 'its own memory still works');
	assert.equal(two.get('key'), undefined, 'this is exactly what a shared directory fixes');
});

test('two kinds of mark in one directory do not collide', () =>
	withTempDir('node-kinds-', async (dir) => {
		sharedMarks(dir, 'stats').set('same', 1);
		sharedMarks(dir, 'logs').set('same', 2);
		assert.equal(sharedMarks(dir, 'stats').get('same'), 1);
		assert.equal(sharedMarks(dir, 'logs').get('same'), 2);
	}));

// A key is a URL or a path in practice, and either would make a filename nothing can create.
test('a key with separators in it still names one file', () =>
	withTempDir('node-key-', async (dir) => {
		const marks = sharedMarks(dir, 'stats');
		marks.set('https://127.0.0.1:5012/debug/vars', 42);
		assert.equal(marks.get('https://127.0.0.1:5012/debug/vars'), 42);
		assert.equal(readdirSync(dir).length, 1, JSON.stringify(readdirSync(dir)));
	}));

test('NEGATIVE: an unreadable or nonsense mark reads as no mark rather than as zero', () =>
	withTempDir('node-bad-', async (dir) => {
		const marks = sharedMarks(dir, 'stats');
		for (const body of ['', 'not a number', '0', '-1', 'NaN']) {
			writeFileSync(join(dir, 'stats-k.mark'), body);
			assert.equal(marks.get('k'), undefined, JSON.stringify(body));
		}
	}));

test('no scratch file survives a mark write', () =>
	withTempDir('node-scratch-', async (dir) => {
		sharedMarks(dir, 'stats').set('k', 7);
		assert.deepEqual(readdirSync(dir), ['stats-k.mark']);
	}));

// An unwritable directory costs the recall, not the caller: a status read must not throw because a mark
// could not be kept.
test('NEGATIVE: a mark store over a path that is not a directory does not throw', () => {
	const marks = sharedMarks('/dev/null/nope', 'stats');
	assert.doesNotThrow(() => marks.set('k', 1));
	assert.equal(marks.get('k'), undefined);
});

test('the first claimant may do the work', () =>
	withTempDir('node-claim-', async (dir) => {
		assert.equal(claimSingleton({ dir, file: 'series.claim', holder: 'a', staleMs: 45_000 }), true);
	}));

// The whole point. Eight threads with an ungated timer send eight copies of every gauge.
test('NEGATIVE: a second thread is refused while the first holds the claim', () =>
	withTempDir('node-second-', async (dir) => {
		const at = 1_757_000_000_000;
		assert.equal(claimSingleton({ dir, file: 'series.claim', holder: 'a', staleMs: 45_000, now: at }), true);
		assert.equal(
			claimSingleton({ dir, file: 'series.claim', holder: 'b', staleMs: 45_000, now: at + 1000 }),
			false,
			'two threads would both send, and every gauge would read double'
		);
		assert.equal(
			claimSingleton({ dir, file: 'series.claim', holder: 'a', staleMs: 45_000, now: at + 1000 }),
			true,
			'the holder must be able to refresh its own claim'
		);
	}));

// A thread that dies stops refreshing. There is no unlock path, so expiry is the only way the work comes back.
test('a claim nobody refreshed is taken over once it is stale', () =>
	withTempDir('node-stale-', async (dir) => {
		const at = 1_757_000_000_000;
		claimSingleton({ dir, file: 'series.claim', holder: 'dead', staleMs: 45_000, now: at });
		assert.equal(claimSingleton({ dir, file: 'series.claim', holder: 'b', staleMs: 45_000, now: at + 44_999 }), false);
		assert.equal(claimSingleton({ dir, file: 'series.claim', holder: 'b', staleMs: 45_000, now: at + 45_000 }), true);
	}));

// Every claimant is a thread of one process, so they share a clock. A stamp in the future is a clock
// correction under a living holder, and calling that stale puts a second sender on the wire.
test('NEGATIVE: a stamp in the future reads as live, not as expired', () =>
	withTempDir('node-future-', async (dir) => {
		const at = 1_757_000_000_000;
		writeFileSync(join(dir, 'series.claim'), `a ${at + 60_000}\n`);
		assert.equal(claimSingleton({ dir, file: 'series.claim', holder: 'b', staleMs: 45_000, now: at }), false);
	}));

// The on-disk form is what a second thread parses, so it is part of the contract rather than an internal
// detail: `<holder> <timestamp>`, one line.
test('a claim records who holds it and when', () =>
	withTempDir('node-form-', async (dir) => {
		claimSingleton({ dir, file: 'series.claim', holder: 'a', staleMs: 45_000, now: 1000 });
		assert.match(readFileSync(join(dir, 'series.claim'), 'utf-8'), /^a 1000\n$/);
	}));

// A claim nobody can parse must not read as one nobody can take: a permanent lock would stop the work for the
// life of the node, and there is no unlock path to recover it with.
test('NEGATIVE: a garbled claim is unheld, not a permanent lock', () =>
	withTempDir('node-junk-', async (dir) => {
		for (const junk of ['', 'a', 'a notanumber\n', '\n\n', 'a NaN 1000']) {
			writeFileSync(join(dir, 'series.claim'), junk);
			assert.equal(
				claimSingleton({ dir, file: 'series.claim', holder: 'b', staleMs: 45_000, now: 1000 }),
				true,
				JSON.stringify(junk)
			);
		}
	}));

test('NEGATIVE: an unwritable claim directory refuses the work rather than allowing every thread', () => {
	assert.equal(
		claimSingleton({ dir: '/dev/null/nope', file: 'series.claim', holder: 'a', staleMs: 45_000 }),
		false,
		'proceeding on a failed write is the one outcome the claim exists to prevent'
	);
});

test('two kinds of work claim separately', () =>
	withTempDir('node-two-', async (dir) => {
		const at = 1_757_000_000_000;
		assert.equal(claimSingleton({ dir, file: 'series.claim', holder: 'a', staleMs: 45_000, now: at }), true);
		assert.equal(claimSingleton({ dir, file: 'sweep.claim', holder: 'b', staleMs: 45_000, now: at }), true);
	}));

// Three cadences, so a holder that misses one tick to a slow read does not hand the work over and double the
// output for an interval.
test('the stale window is three cadences', () => {
	assert.equal(claimStaleMs(15), 45_000);
	assert.equal(claimStaleMs(60), 180_000);
	assert.ok(claimStaleMs(15) > 15_000 * 2, 'one missed tick must not lose the claim');
});

test('a /proc status gives resident bytes and thread count', () => {
	const status = 'Name:\tdatadog-agent\nThreads:\t14\nVmRSS:\t  132048 kB\nVmSize:\t 1400000 kB\n';
	assert.deepEqual(
		readProcess(4242, 'linux', () => status),
		{ rssBytes: 132_048 * 1024, threads: 14 }
	);
});

// VmSize is virtual address space, far above resident size on a Go process, and is not the node's memory.
test('NEGATIVE: resident memory is VmRSS, not VmSize', () => {
	const status = 'VmSize:\t 1400000 kB\nVmRSS:\t  132048 kB\nThreads:\t14\n';
	const read = readProcess(1, 'linux', () => status);
	assert.equal(read?.rssBytes, 132_048 * 1024);
	assert.notEqual(read?.rssBytes, 1_400_000 * 1024);
});

// VmSize is on every process, and falling back to it would publish reserved address space as memory.
test('NEGATIVE: a status with no VmRSS is no measurement, even when VmSize is right there', () => {
	assert.equal(
		readProcess(1, 'linux', () => 'Name:\tthing\nThreads:\t3\nVmSize:\t 1400000 kB\n'),
		null
	);
	assert.equal(
		readProcess(1, 'linux', () => 'Name:\tthing\nThreads:\t3\n'),
		null
	);
});

// A zero here would be a false floor on a dashboard: a monitor sees no data instead of a process using none.
test('NEGATIVE: what cannot be measured is null, never a zero', () => {
	assert.equal(
		readProcess(1, 'darwin', () => 'VmRSS:\t100 kB\n'),
		null,
		'macOS has no /proc to read'
	);
	assert.equal(
		readProcess(1, 'win32', () => 'VmRSS:\t100 kB\n'),
		null
	);
	assert.equal(
		readProcess(0, 'linux', () => 'VmRSS:\t100 kB\n'),
		null,
		'pid 0 selects a process group'
	);
	assert.equal(
		readProcess(-1, 'linux', () => 'VmRSS:\t100 kB\n'),
		null
	);
	assert.equal(
		readProcess(1.5, 'linux', () => 'VmRSS:\t100 kB\n'),
		null
	);
	for (const bad of [Number.NaN, undefined, null, '7'])
		assert.equal(
			readProcess(/** @type {any} */ (bad), 'linux', () => 'VmRSS:\t100 kB\n'),
			null,
			JSON.stringify(bad)
		);
	assert.equal(
		readProcess(1, 'linux', () => {
			throw Object.assign(new Error('gone'), { code: 'ENOENT' });
		}),
		null,
		'a process that exits between the listing and the read is ordinary under chaos'
	);
});

test("this process's own resident size needs no /proc", () => {
	const own = selfProcess();
	assert.ok(own.rssBytes > 0);
	assert.equal(own.threads, 0);
	assert.equal(selfProcess(/** @type {any} */ ({ memoryUsage: () => ({ rss: 123 }) })).rssBytes, 123);
});
