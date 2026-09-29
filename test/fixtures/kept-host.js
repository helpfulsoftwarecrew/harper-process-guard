// A host that starts one process under a keeper, reports its pid and stays up until the test kills it.
import { spawn } from 'node:child_process';

import { superviseProcess } from '../../src/supervise.js';
import { context, tuning } from '../support/harness.js';

const [pidDir = '', name = '', restartBaseMs = '0', binaryPath = '', ...args] = process.argv.slice(2);
const ctx = context(pidDir, spawn, { keeper: true, tuning: tuning({ restartBaseMs: Number(restartBaseMs) }) });
const state = await superviseProcess(ctx, {
	name,
	title: name,
	binaryPath,
	args,
	argv: [binaryPath, ...args],
	spawnOptions: { stdio: 'ignore' },
});

process.stdout.write(`${JSON.stringify({ pid: state.pid, error: state.error })}\n`);
setInterval(() => {}, 1 << 30);
