// Harper's spawn hands back the pid in <root>/pids/<name>.pid whenever kill(pid, 0) answers, and after a
// restart a thread of Harper itself can answer, so the file has to go before the guard asks for a spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { clearStaleHostPidFiles } from '../../src/index.js';
import { withTempDir } from '../support/sandbox.js';
import { captureLogs } from '../support/sandbox.js';

const pidFile = (/** @type {string} */ root, /** @type {string} */ name) => path.join(root, 'pids', `${name}.pid`);
const write = (/** @type {string} */ root, /** @type {string} */ name, /** @type {number} */ pid) => {
	fs.mkdirSync(path.join(root, 'pids'), { recursive: true });
	fs.writeFileSync(pidFile(root, name), `${pid}\n`);
};

test('NEGATIVE: a Harper pid file naming a live pid that is not the agent is removed, and the log says what it was running', () =>
	withTempDir('dd-hpid-', async (root) => {
		// This process is alive and is running node, not a trace-agent.
		write(root, 'datadog-trace-agent', process.pid);
		const lines = await captureLogs(() =>
			clearStaleHostPidFiles(
				root,
				[
					{
						name: 'datadog-trace-agent',
						argv: ['/opt/dd/bin/trace-agent', 'run'],
					},
				],
				console
			)
		);
		assert.equal(fs.existsSync(pidFile(root, 'datadog-trace-agent')), false, 'the stale file survived');
		const line = lines.find((entry) => entry.includes('removed'));
		assert.ok(line, 'nothing was logged about the removal');
		assert.match(line, new RegExp(`named pid ${process.pid}, which is running`));
	}));

test("a Harper pid file naming the real process is Harper's to keep, and one naming a dead pid too", () =>
	withTempDir('dd-hpid-', async (root) => {
		// Matching argv: this process, under its own command line, is "the agent" for this test.
		write(root, 'datadog-agent', process.pid);
		write(root, 'datadog-agent-reaper', 2 ** 22 - 7);
		const lines = await captureLogs(() =>
			clearStaleHostPidFiles(
				root,
				[
					{ name: 'datadog-agent', argv: [/** @type {string} */ (process.argv[0])] },
					{ name: 'datadog-agent-reaper', script: '/reaper.js' },
				],
				console
			)
		);
		assert.equal(fs.existsSync(pidFile(root, 'datadog-agent')), true, "the real process's file was removed");
		assert.equal(
			fs.existsSync(pidFile(root, 'datadog-agent-reaper')),
			true,
			"a dead pid's file was removed; Harper clears those itself"
		);
		assert.deepEqual(lines, []);
	}));

test('a reaper file naming a live pid that is not running reaper.js is removed', () =>
	withTempDir('dd-hpid-', async (root) => {
		write(root, 'datadog-agent-reaper', process.pid);
		const lines = await captureLogs(() =>
			clearStaleHostPidFiles(root, [{ name: 'datadog-agent-reaper', script: '/reaper.js' }], console)
		);
		assert.equal(fs.existsSync(pidFile(root, 'datadog-agent-reaper')), false);
		assert.equal(lines.length, 1);
	}));

test('no root, nothing to clear', async () => {
	const lines = await captureLogs(() => clearStaleHostPidFiles(null, [{ name: 'x', argv: ['y'] }], console));
	assert.deepEqual(lines, []);
});
