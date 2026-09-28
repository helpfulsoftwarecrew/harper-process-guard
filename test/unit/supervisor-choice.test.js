// Which supervisor a host gets, and what happens when the one it was given cannot do the job.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { supervisesNatively, supervisorFor } from '../../src/index.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
// Never called on either path here: the native one delegates to the host and the bundled one is only asked for
// its `kind`. Typed as the real Spawn so the cast is honest about what a caller would have to supply.
const spawn = /** @type {import('../../src/supervise.js').Spawn} */ (
	() => {
		throw new Error('the spawn stub must not be reached');
	}
);
const options = (extra = {}) => ({ log: silent, spawn, label: 'probe', reaperName: 'probe-reaper', ...extra });

/**
 * A host exposing the native surface: the duck-type is `processes.start` being callable and nothing more.
 * `processes` is declared optional so a test can take it away, which is the case the refusal exists for.
 *
 * @param {(descriptor: any) => Promise<any>} [start] @param {any} [reaper]
 * @returns {{ processes: { start: (descriptor: any) => Promise<any>, reaper: any } | undefined }}
 */
const nativeScope = (start = async () => ({ started: true }), /** @type {any} */ reaper = undefined) => ({
	processes: { start, reaper },
});

test('a host with no scope.processes gets the bundled guard', () => {
	assert.equal(supervisesNatively({}), false);
	assert.equal(supervisorFor({}, options()).kind, 'guard');
});

test('a host exposing scope.processes.start gets the native path, under the kind the consumer chose', () => {
	const scope = nativeScope();
	assert.equal(supervisesNatively(scope), true);
	assert.equal(supervisorFor(scope, options()).kind, 'host');
	// The consumer owns this string because its status endpoint has published it; renaming it is not a refactor.
	assert.equal(supervisorFor(scope, options({ nativeKind: 'harper' })).kind, 'harper');
});

// The duck-type is the whole check, so anything that is not a callable `start` is not a native host. A scope
// carrying a truthy `processes` with no start would otherwise take the native path and fail on first use.
test('NEGATIVE: a processes member without a callable start is not a native host', () => {
	for (const processes of [undefined, null, {}, { start: null }, { start: 'yes' }, { start: 42 }, []]) {
		assert.equal(supervisesNatively({ processes }), false, `processes = ${JSON.stringify(processes)}`);
		assert.equal(supervisorFor({ processes }, options()).kind, 'guard');
	}
});

// A host can pass the duck-type when asked and fail it at start, and a TypeError tells an operator nothing.
test('a host that loses scope.processes between the choice and the start is refused by name', async () => {
	const scope = nativeScope();
	const supervisor = supervisorFor(scope, options({ nativeKind: 'harper' }));
	scope.processes = undefined;

	await assert.rejects(
		() =>
			supervisor.start([{ name: 'agent', title: 'agent', command: '/bin/true', args: [] }], {
				configFiles: {},
				fingerprintParts: ['v1'],
			}),
		(error) => {
			assert.ok(error instanceof Error);
			assert.doesNotMatch(error.message, /Cannot read properties/, 'a TypeError is not a diagnosis');
			assert.match(error.message, /probe:/, 'the refusal names the consumer');
			assert.match(error.message, /scope\.processes\.start/, 'and the member it wanted');
			assert.match(error.message, /bundled guard/, 'and the alternative');
			return true;
		}
	);
});

test('the native path reports the states the host produced, tagged with the descriptor', async () => {
	const scope = nativeScope(async (descriptor) => ({
		started: true,
		pid: 4242,
		verified: true,
		name: descriptor.name,
	}));
	const supervisor = supervisorFor(scope, options({ nativeKind: 'harper' }));
	const { processes, report } = await supervisor.start(
		[{ name: 'agent-x', title: 'agent X', command: '/bin/true', args: [] }],
		{ configFiles: {}, fingerprintParts: ['v1'] }
	);
	assert.equal(processes.length, 1);
	assert.equal(processes[0].name, 'agent-x');
	assert.equal(processes[0].title, 'agent X');
	assert.equal(processes[0].kind, undefined, 'the descriptor carried no kind, so none is invented');
	assert.equal(processes[0].verified, true);
	// The consumer surfaces this so an operator can tell which supervisor ran without reading the code.
	assert.match(report.join(' '), /bundled process guard is present but unused/);
});

// A native start that rejects is one process failing, not the node failing: the others still report.
test('a native start that rejects becomes an unstarted state rather than taking the call down', async () => {
	let calls = 0;
	const scope = nativeScope(async (descriptor) => {
		calls += 1;
		if (descriptor.name === 'bad') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		return { started: true, verified: true };
	});
	const supervisor = supervisorFor(scope, options({ nativeKind: 'harper' }));
	const { processes } = await supervisor.start(
		[
			{ name: 'good', title: 'good', command: '/bin/true', args: [] },
			{ name: 'bad', title: 'bad', command: '/nope', args: [] },
		],
		{ configFiles: {}, fingerprintParts: ['v1'] }
	);
	assert.equal(calls, 2, 'both descriptors were attempted');
	assert.equal(processes[0].started, true);
	assert.equal(processes[1].started, false);
	assert.equal(processes[1].name, 'bad');
	assert.ok(processes[1].error, 'the failure is carried on the state, not lost');
});

// `pid` is how an operator finds the reaper and `exited` is the native path's death signal, so a filtered
// copy loses both, and any copy freezes a state the host goes on mutating.
test('the native reaper is published whole, as the same object the host goes on mutating', async () => {
	/** @type {Record<string, any>} */
	const reaper = { name: 'probe-reaper', started: true, adopted: false, pid: 991, exited: false, host: 'extra' };
	const scope = nativeScope(async () => ({ started: true }), reaper);
	const supervisor = supervisorFor(scope, options({ nativeKind: 'harper' }));
	const { reaper: published } = await supervisor.start(
		[{ name: 'agent', title: 'agent', command: '/bin/true', args: [] }],
		{ configFiles: {}, fingerprintParts: ['v1'] }
	);

	assert.equal(published, reaper, 'a copy freezes a status endpoint on what was true at boot');
	assert.equal(published.pid, 991, 'the field an operator needs to find the process');
	assert.equal(published.exited, false, 'and the one that carries its death');
	assert.equal(published.host, 'extra', 'a host field this package does not know is not this package to drop');

	// The host mutates its own state in place, which is the whole reason it is not copied here
	reaper.started = false;
	reaper.exited = true;
	reaper.error = 'the reaper was terminated by SIGKILL';
	assert.equal(published.started, false);
	assert.equal(published.error, 'the reaper was terminated by SIGKILL');
});

test('a host with no reaper publishes none, rather than an empty object', async () => {
	const supervisor = supervisorFor(nativeScope(), options({ nativeKind: 'harper' }));
	const { reaper } = await supervisor.start([{ name: 'a', title: 'a', command: '/bin/true', args: [] }], {
		configFiles: {},
		fingerprintParts: ['v1'],
	});
	assert.equal(reaper, undefined);
});
