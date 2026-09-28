// A host's spawn can hand back another process's pid, and the thread that refused it reports `started: false`
// while the node's process runs under another thread, so that refusal is a diagnostic rather than the health.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { nodeProcess } from '../../src/node.js';
import { retakeVerdict } from '../../src/verdict.js';

const NAME = 'datadog-agent';
const DEAD_PID = 2 ** 22 - 7;
const REFUSAL =
	'this node never started it: the spawn of the core agent handed back pid 878, which is running the trace-agent';

const refusedState = () => ({
	name: NAME,
	kind: 'core',
	started: false,
	adopted: false,
	exited: false,
	restarts: 0,
	verified: false,
	verifiedPid: null,
	error: REFUSAL,
});

describe('what the node has, for a thread that has nothing', () => {
	/** @type {string} */
	let dir;
	/** @type {any} */
	let child;
	/** @type {string[]} */
	let childArgv;

	const lock = (/** @type {number} */ pid, /** @type {any} */ argv) =>
		writeFileSync(join(dir, `${NAME}.pid`), `${pid}\n7\n${JSON.stringify({ token: 't', host: 1, argv })}`);

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'dd-node-process-'));
		childArgv = [process.execPath, '-e', 'setInterval(function () {}, 1000)'];
		child = spawn(String(childArgv[0]), childArgv.slice(1), { stdio: 'ignore' });
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	after(() => {
		child?.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports the process the lock identifies, and keeps the thread's refusal", () => {
		lock(child.pid, childArgv);
		const now = nodeProcess(refusedState(), dir);
		assert.equal(now.started, true, 'the node has this agent, whatever this thread was handed');
		assert.equal(now.pid, child.pid);
		assert.equal(now.adopted, true);
		assert.equal(now.refused, REFUSAL, 'the refusal is kept, not lost');
		assert.equal(now.error, undefined, "and it stops being reported as the agent's error");
		assert.equal(now.verified, undefined, 'no verdict has been taken against this pid by this thread');
	});

	it("leaves a verdict to be retaken against the node's pid rather than publishing none", async () => {
		lock(child.pid, childArgv);
		const verify = async (/** @type {any} */ state) => ({
			ok: true,
			detail: `the core agent serves expvar as pid ${state.pid}`,
		});
		const now = await retakeVerdict(nodeProcess(refusedState(), dir), verify);
		assert.equal(now.verified, true);
		assert.match(now.verifyDetail, new RegExp(String(child.pid)));
	});

	it('NEGATIVE: keeps the refusal when the lock names a pid nothing holds', () => {
		lock(DEAD_PID, childArgv);
		const now = nodeProcess(refusedState(), dir);
		assert.equal(now.started, false, 'nothing is running, so nothing is reported running');
		assert.equal(now.error, REFUSAL);
	});

	it('NEGATIVE: keeps the refusal when the lock names a live pid running something else', () => {
		lock(child.pid, ['/nonexistent/datadog-agent', 'run']);
		const now = nodeProcess(refusedState(), dir);
		assert.equal(now.started, false, "an unidentified pid is not this node's agent");
		assert.equal(now.error, REFUSAL);
	});

	it('NEGATIVE: leaves a thread that started its own process exactly as it is', () => {
		lock(child.pid, childArgv);
		const own = {
			...refusedState(),
			started: true,
			pid: 4242,
			verified: true,
			error: undefined,
		};
		assert.equal(nodeProcess(own, dir), own);
	});

	it('NEGATIVE: does nothing without a pid directory', () => {
		const state = refusedState();
		assert.equal(nodeProcess(state, undefined), state);
	});

	// A host supervising natively keeps its own locks elsewhere, and live state that needs no lock read.
	it('NEGATIVE: reads no lock at all when the host supervises natively, even one that would match', () => {
		lock(child.pid, childArgv);
		const state = refusedState();
		assert.equal(nodeProcess(state, dir, 'harper'), state, 'a native host keeps its own state');
		assert.equal(nodeProcess(state, dir, 'host'), state);
		// And the same lock still adopts on the path this function was written for
		assert.equal(nodeProcess(state, dir, 'guard').started, true);
	});
});

// A deliberate stop sets `exited`, leaves `started` alone and releases the lock, so reading `started` alone
// would report a stopped process as running.
describe('what the node has, for a thread whose agent died', () => {
	/** @type {string} */
	let dir;
	/** @type {any} */
	let child;
	/** @type {string[]} */
	let childArgv;

	const lock = (/** @type {number} */ pid, /** @type {any} */ argv) =>
		writeFileSync(join(dir, `${NAME}.pid`), `${pid}\n7\n${JSON.stringify({ token: 't', host: 1, argv })}`);

	const diedState = () => ({
		name: NAME,
		kind: 'core',
		// What a deliberate stop leaves: started stays true, exited turns on, and the lock is released.
		started: true,
		adopted: false,
		exited: true,
		pid: 879,
		restarts: 0,
		verified: true,
		verifiedPid: 879,
	});

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'dd-node-exited-'));
		childArgv = [process.execPath, '-e', 'setInterval(function () {}, 1000)'];
		child = spawn(String(childArgv[0]), childArgv.slice(1), { stdio: 'ignore' });
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	after(() => {
		child?.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	});

	it('reports the agent down once its lock is gone, rather than started and verified', () => {
		// No lock file in this directory at all, which is the state a deliberate stop leaves.
		const now = nodeProcess(diedState(), dir);
		assert.equal(now.started, false, 'an agent nothing on the node is running must not read as started');
		// The pid stays: `started: false` already says it is down, and the pid is what an operator looks up.
		assert.equal(now.pid, 879);
		assert.equal(now.exited, true);
	});

	it('NEGATIVE: the native path is left alone, because no other supervisor keeps this lock', () => {
		// A native host's `exited` is its own answer, and a guard lock read there would second-guess it.
		const native = diedState();
		assert.equal(nodeProcess(native, dir, 'harper'), native);
	});

	it('adopts the replacement when the guard restarted it under a new pid', () => {
		// After a SIGKILL the guard restarts under a new pid, so this thread's state is stale the other way.
		lock(child.pid, childArgv);
		const now = nodeProcess(diedState(), dir);
		assert.equal(now.started, true);
		assert.equal(now.pid, child.pid);
		assert.equal(now.adopted, true);
		assert.equal(now.exited, false, 'exited describes the pid this thread watched, not the one now running');
	});

	it('NEGATIVE: a live pid running something else is not the agent', () => {
		lock(process.pid, ['/usr/bin/something-else', 'run']);
		const now = nodeProcess(diedState(), dir);
		assert.equal(now.started, false, 'an unidentified pid cannot stand in for the agent');
	});
});
