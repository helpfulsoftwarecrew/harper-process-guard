// Harper calls a plugin only for a component the root config names; one found by scanning componentsRoot is
// imported and discarded, so module evaluation is the only place left to notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHandleApplication, watchForNeverCalled } from '../../src/host.js';

const collector = () => {
	/** @type {string[]} */
	const lines = [];
	return {
		lines,
		log: {
			info: () => {},
			warn: () => {},
			error: (/** @type {string} */ line) => lines.push(line),
		},
	};
};

test('a plugin that is never called is reported, naming the config entry to add', async () => {
	const { lines, log } = collector();
	watchForNeverCalled({
		log,
		label: 'test supervisor',
		configEntry: 'my-component: { package: "@scope/pkg" }',
		deadlineMs: 10,
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(lines.length, 2);
	const [first, second] = lines;
	assert.ok(first && second);
	assert.match(first, /^test supervisor: Harper has not called handleApplication/);
	assert.match(second, /my-component: \{ package: "@scope\/pkg" \}/);
});

// The whole point: being called is what makes the diagnostic wrong, so it must not fire afterwards.
test('NEGATIVE: a plugin that is called reports nothing', async () => {
	const { lines, log } = collector();
	const deadline = watchForNeverCalled({
		log,
		label: 'test',
		configEntry: 'x',
		deadlineMs: 10,
	});
	deadline.seen();
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(lines, []);
});

test("the label is the caller's, so this file names no consumer", async () => {
	const { lines, log } = collector();
	watchForNeverCalled({ log, label: 'anything at all', configEntry: 'x', deadlineMs: 5 });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.ok(lines.every((line) => line.startsWith('anything at all: ')));
});

const slotFor = () => {
	/** @type {Promise<any> | undefined} */
	let held;
	return {
		get: () => held,
		set: (/** @type {Promise<any>} */ promise) => (held = promise),
		read: () => held,
	};
};

test('the plugin starts once per thread however many times Harper calls it', () => {
	let starts = 0;
	const slot = slotFor();
	const handle = createHandleApplication({
		start: () => Promise.resolve({ started: ++starts }),
		deadline: { seen: () => {} },
		slot,
	});
	handle({});
	handle({});
	handle({});
	assert.equal(starts, 1, 'a second call must join the first, not start again');
	assert.ok(slot.read(), 'the promise is kept so the read path sees the same one');
});

// A deploy pre-flight loads the component against a live node purely to validate it. Starting there
// re-enters the sweep and spawn path on every `harper deploy`.
test('NEGATIVE: a transient validation load starts nothing', () => {
	let starts = 0;
	const slot = slotFor();
	const handle = createHandleApplication({
		start: () => Promise.resolve({ started: ++starts }),
		deadline: { seen: () => {} },
		slot,
	});
	handle({ isTransientValidation: true });
	assert.equal(starts, 0);
	assert.equal(slot.read(), undefined);
});

// Harper reached the plugin either way, so the never-called diagnostic is wrong even for a validation load.
test('a validation load still cancels the never-called diagnostic', () => {
	let seen = false;
	createHandleApplication({
		start: () => Promise.resolve({}),
		deadline: { seen: () => (seen = true) },
		slot: slotFor(),
	})({ isTransientValidation: true });
	assert.equal(seen, true);
});
