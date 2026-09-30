// @ts-check
// Identification decides what may be signalled, so every case here is about what the guard is allowed
// to conclude, not about what it happens to read.
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import {
	argvOf,
	compareArgv,
	identify,
	identifyBudgetMs,
	isAlive,
	parseCimAnswer,
	probeCim,
	windowsCommandLine,
} from '../../src/identity.js';
import {
	anotherStart,
	deadPid,
	fixture,
	KEEPER_SCRIPT,
	pidOf,
	readyLine,
	skipOnWindows,
	waitFor,
	WINDOWS,
	withSpawn,
} from '../support/harness.js';

// Harper's vm-current-context sandbox substitutes node:child_process with only these five names;
// execFileSync isn't one, and a real Harper node refuses to load a component that imports it.
const HARPER_CHILD_PROCESS_STUB = new Set(['exec', 'execFile', 'fork', 'spawn', 'execSync']);

test('identity.js imports only what a real Harper node actually gives it from node:child_process', () => {
	const source = fs.readFileSync(new URL('../../src/identity.js', import.meta.url), 'utf-8');
	const imported = source.match(/import \{ ([^}]+) \} from 'node:child_process';/)?.[1];
	assert.ok(imported, 'expected a named import from node:child_process');
	for (const name of imported.split(',').map((n) => n.trim())) {
		assert.ok(HARPER_CHILD_PROCESS_STUB.has(name), `'${name}' is not in Harper's constrained child_process`);
	}
});

test('pid 1 reads as alive, so a containerised host is not reaped on sight', (t) => {
	if (skipOnWindows(t, 'Windows issues no pid 1; the lowest is the System process at 4')) return;
	// Inside a container the host process IS pid 1. A guard that treats 1 as an invalid pid stops it.
	assert.equal(isAlive(1), true);
});

test('the pids that are not pids read as dead, because kill(2) reads them as process groups', () => {
	assert.equal(isAlive(0), false, 'pid 0 is the caller’s own process group');
	assert.equal(isAlive(-1), false, 'a negative is group -n');
	assert.equal(isAlive(1.5), false);
	assert.equal(isAlive(Number.NaN), false);
});

test('a pid nothing holds reads as dead', async () => {
	assert.equal(isAlive(await deadPid()), false);
});

test('two node scripts are told apart by argv, which is the only thing that separates them', () =>
	withSpawn(async ({ spawn }) => {
		// Both run the same executable, so an identification by executable calls these one process.
		const first = [process.execPath, fixture('idle.js'), 'alpha'];
		const second = [process.execPath, fixture('idle.js'), 'beta'];
		const a = spawn(process.execPath, first.slice(1), { stdio: 'ignore' });
		const b = spawn(process.execPath, second.slice(1), { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(a)) !== null && argvOf(pidOf(b)) !== null, 'both children to appear');

		assert.equal(identify(pidOf(a), first), 'match');
		assert.equal(identify(pidOf(b), second), 'match');
		assert.equal(identify(pidOf(a), second), 'differs');
		assert.equal(identify(pidOf(b), first), 'differs');
		// An expectation of the interpreter alone matches either child, which is why the executable identifies nothing.
		assert.equal(identify(pidOf(a), [process.execPath]), 'match');
		assert.equal(identify(pidOf(b), [process.execPath]), 'match');
	}));

test('a command line holding non-ASCII identifies as itself, as a home directory or install path can', () =>
	withSpawn(async ({ spawn }) => {
		const argv = [process.execPath, fixture('idle.js'), `/Users/José/hdb/café-${process.pid}`];
		const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
		assert.equal(identify(pidOf(child), argv), 'match');
	}));

test('a reader whose locale is broken, foreign or unset, in another zone, reads the same command line and start time', (t) => {
	if (skipOnWindows(t, 'win32 reads its command lines through no locale and records no start time')) return;
	return withSpawn(async ({ spawn }) => {
		const { startedAt } = await import('../../src/identity.js');
		const argv = [process.execPath, fixture('idle.js'), `/Users/José/hdb/café-${process.pid}`];
		const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
		const started = startedAt(pidOf(child));
		assert.equal(typeof started, 'string', 'no start time was read here');
		const script =
			`const { identify, startedAt } = await import(${JSON.stringify(new URL('../../src/identity.js', import.meta.url).href)});` +
			'const [pid, argv] = [Number(process.argv[1]), JSON.parse(process.argv[2])];' +
			'console.log(JSON.stringify({ verdict: identify(pid, argv), started: startedAt(pid) }));';
		const bare = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => key !== 'LANG' && !key.startsWith('LC_'))
		);
		for (const locale of [
			{},
			{ LANG: 'garbage' },
			{ LANG: 'de_DE.UTF-8', LC_MESSAGES: 'garbage' },
			{ LC_ALL: 'de_DE.UTF-8' },
		]) {
			const env = { ...bare, ...locale, TZ: 'Asia/Tokyo' };
			const answer = execFileSync(
				process.execPath,
				['--input-type=module', '-e', script, String(pidOf(child)), JSON.stringify(argv)],
				{ env, encoding: 'utf-8' }
			);
			assert.deepEqual(JSON.parse(answer), { verdict: 'match', started }, `read with ${JSON.stringify(locale)}`);
		}
	});
});

test('a leading run matches, and pinning more of the command line can only narrow the verdict', () =>
	withSpawn(async ({ spawn }) => {
		const argv = [process.execPath, fixture('idle.js'), 'pinned', '--extra'];
		const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear');

		assert.equal(identify(pidOf(child), argv.slice(0, 2)), 'match', 'a prefix must match');
		assert.equal(identify(pidOf(child), argv), 'match', 'the whole vector must match');
		assert.equal(identify(pidOf(child), [...argv, 'more']), 'differs', 'a longer expectation cannot match');
	}));

test('an empty expectation identifies nothing, so a lock with no recorded argv is never signalled', () => {
	// The reaper reads argv off the lock, so a 'match' here would let it kill whatever a foreign pid file names.
	assert.equal(compareArgv(['/bin/anything'], []), 'unknown');
	assert.equal(identify(process.pid, []), 'unknown');
});

test('a command line nothing can read is "cannot tell", never "not ours"', () => {
	assert.equal(compareArgv(null, ['/bin/thing']), 'unknown');
});

test('a matching prefix must end on an argument boundary', () => {
	assert.equal(compareArgv(['/bin/thing', '--config'], ['/bin/thing', '--conf']), 'differs');
	assert.equal(compareArgv(['/bin/thing', '--conf', 'x'], ['/bin/thing', '--conf']), 'match');
});

test('a dead pid identifies as something else, so nothing acts on it as though it were still there', async () => {
	assert.equal(identify(await deadPid(), [process.execPath]), 'differs');
});

test('a zombie is not alive: it holds its pid and answers kill(pid, 0), but runs nothing', async (t) => {
	// libuv's kill(pid, 0) reads GetExitCodeProcess on Windows, which settles its nearest thing to a zombie.
	if (skipOnWindows(t, 'Windows has no zombie state; kill(pid, 0) settles the terminated-but-handled pid')) return;
	// `exec` replaces the shell, so nothing waits on the backgrounded child, as under a non-reaping init.
	await withSpawn(async ({ spawn }) => {
		const parent = spawn('/bin/sh', ['-c', 'sleep 0.05 & echo $! ; exec sleep 30'], {
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const printed = await readyLine(parent);
		const zombie = Number(printed);
		assert.ok(Number.isInteger(zombie) && zombie > 0, `the shell printed no pid: ${printed}`);

		await waitFor(() => !isAlive(zombie), 'the backgrounded process to die and stay unreaped');
		// Still a pid nobody has released: kill(pid, 0) succeeds where isAlive() does not.
		let holdsPid = true;
		try {
			process.kill(zombie, 0);
		} catch {
			holdsPid = false;
		}
		assert.equal(holdsPid, true, 'the corpse was reaped before it could be observed');
		assert.equal(isAlive(zombie), false);
	});
});

test('a pid whose parent is the keeper its lock names is ours whatever it runs, and pid 1 vouches for no orphan', async (t) => {
	if (skipOnWindows(t, 'no keeper runs on win32, and its probe reads no parent')) return;
	// Imported here so this file still loads against a source tree without it.
	const { identifyKept } = await import('../../src/identity.js');
	const elsewhere = ['/opt/agent/bin/agent', 'run'];
	// This process stands in for the keeper, so its own command line is what the lock would record.
	const self = /** @type {string[]} */ (argvOf(process.pid));
	await withSpawn(async ({ spawn }) => {
		const child = spawn(process.execPath, [fixture('idle.js'), 'kept-by-this-process'], { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
		assert.equal(identify(pidOf(child), elsewhere), 'differs');
		assert.equal(identifyKept(pidOf(child), elsewhere, process.pid, self), 'match', 'its parent did not vouch for it');
		assert.equal(
			identifyKept(pidOf(child), elsewhere, await deadPid(), self),
			'differs',
			'a pid not its parent vouched'
		);
		assert.equal(identifyKept(pidOf(child), elsewhere, undefined, self), 'differs');
		assert.equal(identifyKept(await deadPid(), elsewhere, process.pid, self), 'differs', 'a dead pid was vouched for');

		const shell = spawn(
			'/bin/sh',
			['-c', `'${process.execPath}' '${fixture('idle.js')}' orphaned >/dev/null 2>&1 & echo $!`],
			{
				stdio: ['ignore', 'pipe', 'ignore'],
			}
		);
		const orphan = Number(await readyLine(shell));
		try {
			await waitFor(() => !isAlive(pidOf(shell)), 'the shell to exit and leave its child to init');
			assert.equal(identifyKept(orphan, elsewhere, 1, argvOf(1) ?? []), 'differs', 'init vouched for an orphan');
		} finally {
			process.kill(orphan, 'SIGKILL');
		}
	});
});

test('NEGATIVE: a parent that is not running the keeper its lock records vouches for nothing, as after pid reuse', async (t) => {
	if (skipOnWindows(t, 'no keeper runs on win32, and its probe reads no parent')) return;
	const { identifyKept } = await import('../../src/identity.js');
	const elsewhere = ['/opt/agent/bin/agent', 'run'];
	const keeperArgv = [process.execPath, KEEPER_SCRIPT, '--keep', '--lock', '/nowhere/agent.pid', '--token', 'gone'];
	await withSpawn(async ({ spawn }) => {
		const child = spawn(process.execPath, [fixture('idle.js'), 'child-of-a-stranger'], { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
		assert.equal(
			identifyKept(pidOf(child), elsewhere, process.pid, keeperArgv),
			'differs',
			'a reused keeper pid vouched'
		);
		assert.equal(
			identifyKept(pidOf(child), elsewhere, process.pid, []),
			'differs',
			'a keeper with no command line vouched'
		);
		assert.equal(
			identifyKept(pidOf(child), [process.execPath], process.pid, keeperArgv),
			'match',
			'its own argv stopped counting'
		);
	});
});

test('a pid that started when its lock records is that process whatever it now runs, and no other start time is', async (t) => {
	if (skipOnWindows(t, 'no keeper runs on win32, so no lock there records a start time')) return;
	const { identifyKept, startedAt } = await import('../../src/identity.js');
	const elsewhere = ['/opt/agent/bin/agent', 'run'];
	await withSpawn(async ({ spawn }) => {
		const child = spawn(process.execPath, [fixture('idle.js'), 'started-at'], { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
		const started = startedAt(pidOf(child));
		assert.equal(typeof started, 'string', 'no start time was read');
		assert.equal(startedAt(pidOf(child)), started, 'a second read disagreed with the first');
		assert.equal(identifyKept(pidOf(child), elsewhere, undefined, [], started ?? ''), 'match');
		assert.equal(identifyKept(pidOf(child), elsewhere, undefined, [], `${started} `), 'differs');
		assert.equal(identifyKept(pidOf(child), elsewhere, undefined, []), 'differs', 'no recorded start time matched');
		assert.equal(identifyKept(await deadPid(), elsewhere, undefined, [], started ?? ''), 'differs');
		assert.equal(startedAt(await deadPid()), null);
	});
});

test('NEGATIVE: a pid whose readable start time is not the one its lock records is not ours, even running its command line', async (t) => {
	if (skipOnWindows(t, 'no keeper runs on win32, so no lock there records a start time')) return;
	const { identifyKept, startedAt } = await import('../../src/identity.js');
	await withSpawn(async ({ spawn }) => {
		// The same binary and arguments under a pid the lock's process once held: another start of the same command.
		const argv = [process.execPath, fixture('idle.js'), 'same-command-another-start'];
		const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear in the process table');
		const started = startedAt(pidOf(child)) ?? assert.fail('no start time was read');
		assert.equal(identifyKept(pidOf(child), argv, undefined, []), 'match', 'the command line itself did not match');
		assert.equal(identifyKept(pidOf(child), argv, undefined, [], anotherStart(started)), 'differs');
		assert.equal(identifyKept(pidOf(child), argv, undefined, [], started), 'match');
	});
});

/**
 * Run `body` with process.platform reporting `platform`. Synchronous on purpose: node:test runs top-level
 * tests one at a time, and an await under the override would leak it into whatever ran next.
 *
 * @template T @param {NodeJS.Platform} platform @param {() => T} body @returns {T}
 */
function onPlatform(platform, body) {
	const real = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(process, 'platform'));
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	try {
		return body();
	} finally {
		Object.defineProperty(process, 'platform', real);
	}
}

test('the win32 probe tells a process that is gone from one that would not say what it is', () => {
	// 'gone' reclaims the lock, and an unreported command line must not, because the guard signals what it identified.
	assert.deepEqual(parseCimAnswer('gone\r\n'), { alive: false, argv: null });
	assert.deepEqual(parseCimAnswer('live C:\\dd\\agent.exe run\r\n'), { alive: true, argv: ['C:\\dd\\agent.exe run'] });
	assert.deepEqual(parseCimAnswer('live \r\n'), { alive: true, argv: null });
});

test('an answer the probe did not write is no answer at all', () => {
	// Output from a failed start or a timeout must not read as 'gone', or a live process loses its lock.
	assert.equal(parseCimAnswer(''), null);
	assert.equal(parseCimAnswer('At line:1 char:1\r\n'), null);
	assert.equal(parseCimAnswer('livewire'), null);
});

test('a BOM in front of redirected PowerShell output does not hide the answer', () => {
	// U+FEFF is whitespace, so trim() strips it where a trimEnd() would leave the marker unmatchable.
	assert.deepEqual(parseCimAnswer('\uFEFFgone\r\n'), { alive: false, argv: null });
	assert.deepEqual(parseCimAnswer('\uFEFFlive C:\\dd\\agent.exe\r\n'), { alive: true, argv: ['C:\\dd\\agent.exe'] });
});

test('a Windows command line identifies the process the guard recorded, quoting and all', () =>
	onPlatform('win32', () => {
		// Windows keeps only the string node's spawn built, where libuv quoted the install path for its space.
		const argv = ['C:\\Program Files\\dd\\agent.exe', 'run', '--cfgpath', 'C:\\ProgramData\\dd'];
		const reported =
			parseCimAnswer('live "C:\\Program Files\\dd\\agent.exe" run --cfgpath C:\\ProgramData\\dd')?.argv ?? null;

		assert.equal(compareArgv(reported, argv), 'match');
		assert.equal(compareArgv(reported, argv.slice(0, 2)), 'match', 'a leading run must match');
		assert.equal(compareArgv(reported, [...argv, 'more']), 'differs', 'a longer expectation cannot match');
		assert.equal(compareArgv(reported, ['C:\\dd\\agent.exe', 'run']), 'differs');
	}));

test('what the probe read back is not an expectation, because win32 re-quotes whatever it is handed', () =>
	onPlatform('win32', () => {
		// argvOf() on win32 is one element, which as an expectation is quoted as one argument and matches nothing.
		const read = parseCimAnswer('live "C:\\Program Files\\dd\\agent.exe" run')?.argv ?? [];
		assert.equal(compareArgv(read, read), 'differs', 'a caller must keep the vector it spawned, not what it read');
		assert.equal(compareArgv(read, ['C:\\Program Files\\dd\\agent.exe', 'run']), 'match');
	}));

test('on win32 a matching prefix still has to end on an argument boundary', () =>
	onPlatform('win32', () => {
		assert.equal(compareArgv(['agent.exe --config x'], ['agent.exe', '--conf']), 'differs');
		assert.equal(compareArgv(['agent.exe --conf x'], ['agent.exe', '--conf']), 'match');
	}));

test('a Windows process that will not report its command line is never identified as ours', () =>
	onPlatform('win32', () => {
		// Win32_Process reports CommandLine null for a process this user may not read, which must not match.
		assert.equal(compareArgv(parseCimAnswer('live ')?.argv ?? null, ['C:\\dd\\agent.exe']), 'unknown');
	}));

test('an argument is quoted the way libuv quotes it, or an install path with a space identifies nothing', () => {
	// The cases libuv documents for quote_cmd_arg, which builds the string Win32_Process reads back.
	assert.equal(windowsCommandLine(['plain']), 'plain');
	assert.equal(windowsCommandLine([String.raw`hello\world`]), String.raw`hello\world`);
	assert.equal(windowsCommandLine([String.raw`hello\\world`]), String.raw`hello\\world`);
	assert.equal(windowsCommandLine([String.raw`hello"world`]), String.raw`"hello\"world"`);
	assert.equal(windowsCommandLine([String.raw`hello""world`]), String.raw`"hello\"\"world"`);
	assert.equal(windowsCommandLine([String.raw`hello\"world`]), String.raw`"hello\\\"world"`);
	assert.equal(windowsCommandLine([String.raw`hello\\"world`]), String.raw`"hello\\\\\"world"`);
	assert.equal(windowsCommandLine(['hello world\\']), '"hello world\\\\"');
	assert.equal(windowsCommandLine(['']), '""');
	// A space and nothing else to escape: libuv wraps and stops there, which is its own branch.
	assert.equal(windowsCommandLine(['dd agent', 'run']), '"dd agent" run');
	assert.equal(
		windowsCommandLine(['C:\\Program Files\\dd\\agent.exe', 'run']),
		'"C:\\Program Files\\dd\\agent.exe" run'
	);
});

test('a win32 node that cannot run the probe answers unknown, never a match', (t) => {
	if (skipOnWindows(t, 'the probe runs here; this covers a host where it cannot')) return;
	onPlatform('win32', () => {
		// No powershell.exe here, which is how a Windows box with broken WMI looks from the caller's side.
		assert.equal(argvOf(process.pid), null);
		assert.equal(identify(process.pid, [process.execPath]), 'unknown');
		assert.equal(isAlive(1), true, 'liveness must not go through the probe');
	});
});

/**
 * What execSync throws for `script` run under `timeoutMs`, so a stand-in for PowerShell fails the way Node does.
 *
 * @param {string} script @param {number} timeoutMs @returns {unknown}
 */
function thrownBy(script, timeoutMs) {
	try {
		execSync(`"${process.execPath}" -e "${script}"`, { encoding: 'utf-8', timeout: timeoutMs, stdio: 'ignore' });
	} catch (error) {
		return error;
	}
	throw new Error(`${script} returned inside ${timeoutMs}ms`);
}

const SERVICE = ['C:\\Program Files\\svc\\worker.exe', 'run'];

test('a probe that runs out of time once and then answers still identifies the process', () => {
	const timedOut = thrownBy('setTimeout(Date.now,5000)', 100);
	let calls = 0;
	/** @type {import('../../src/identity.js').ExecSync} */
	const exec = () => {
		calls += 1;
		if (calls === 1) throw timedOut;
		return `live ${windowsCommandLine(SERVICE)}\r\n`;
	};
	const seen = probeCim(4242, exec);
	onPlatform('win32', () =>
		assert.equal(compareArgv(seen.argv, SERVICE), 'match', 'a cold first start cost the verdict')
	);
	assert.equal(calls, 2);
});

test('a probe that never answers is "cannot tell" once its attempts are spent, all inside the identify budget', () => {
	const timedOut = thrownBy('setTimeout(Date.now,5000)', 100);
	/** @type {number[]} */
	const budgets = [];
	/** @type {import('../../src/identity.js').ExecSync} */
	const exec = (_command, options) => {
		budgets.push(options.timeout ?? Number.POSITIVE_INFINITY);
		// Past any sane attempt count, so a retry loop with no bound fails here rather than hanging the run.
		throw budgets.length > 10 ? new Error('still asking') : timedOut;
	};
	const seen = probeCim(4242, exec);
	// alive with no argv is what identify() turns into 'unknown'; not alive would be 'differs'.
	assert.deepEqual(seen, { alive: true, argv: null });
	onPlatform('win32', () => assert.equal(compareArgv(seen.argv, SERVICE), 'unknown'));
	assert.ok(budgets.length > 1, 'a timed-out probe was not tried again');
	const spent = budgets.reduce((sum, ms) => sum + ms, 0);
	assert.ok(
		spent <= identifyBudgetMs('win32'),
		`${budgets.length} attempts can wait ${spent}ms, past the ${identifyBudgetMs('win32')}ms identify budget`
	);
});

test('a probe that fails for any reason but time is asked once, and one that answers is asked once', () => {
	const failed = thrownBy('process.exit(1)', 5000);
	let calls = 0;
	/** @type {import('../../src/identity.js').ExecSync} */
	const refuses = () => {
		calls += 1;
		throw failed;
	};
	assert.deepEqual(probeCim(4242, refuses), { alive: true, argv: null });
	assert.equal(calls, 1, 'a failure that is not a timeout was paid for twice');

	calls = 0;
	/** @type {import('../../src/identity.js').ExecSync} */
	const answers = () => {
		calls += 1;
		return 'gone\r\n';
	};
	assert.deepEqual(probeCim(4242, answers), { alive: false, argv: null });
	assert.equal(calls, 1, 'a probe that answered was started again');
});

test('a liveness poll on win32 does not pay for a command line nobody asked for', (t) => {
	if (skipOnWindows(t, 'the probe would really run here; this measures the branch that skips it')) return;
	onPlatform('win32', () => {
		// The reaper and supervise poll liveness for the life of the node, and a PowerShell start apiece adds up.
		const started = performance.now();
		for (let i = 0; i < 200; i++) isAlive(1);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 150, `200 liveness checks took ${elapsed.toFixed(0)}ms, so they went through the probe`);
	});
});

/** One thread's identification, in a worker because the win32 probe blocks the thread it runs on. */
const IDENTIFY_IN_WORKER = `
	const { parentPort, workerData } = require('node:worker_threads');
	import(workerData.identity).then(({ identify }) => parentPort.postMessage(identify(workerData.pid, workerData.argv)));
`;

/** @param {number} count @param {number} pid @param {readonly string[]} argv @returns {Promise<string[]>} */
async function identifyAtOnce(count, pid, argv) {
	const { Worker } = await import('node:worker_threads');
	const identity = new URL('../../src/identity.js', import.meta.url).href;
	return Promise.all(
		Array.from(
			{ length: count },
			() =>
				new Promise((resolve, reject) => {
					const worker = new Worker(IDENTIFY_IN_WORKER, {
						eval: true,
						workerData: { identity, pid, argv: [...argv] },
					});
					worker.once('message', resolve);
					worker.once('error', reject);
				})
		)
	);
}

test(
	'eight threads identifying one process at once all still identify it, so a slow probe starts nothing',
	{ timeout: 120_000 },
	async (t) => {
		// Only win32 pays a process start per identification, so only there can eight at once outrun the budget.
		if (!WINDOWS) {
			t.skip('linux reads /proc and darwin forks one `ps`; neither can time out under eight callers');
			return;
		}
		await withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), `concurrent-identity-${process.pid}`];
			const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
			await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear');

			const verdicts = await identifyAtOnce(8, pidOf(child), argv);
			// A timed-out probe reads 'unknown', and a claimant with no verdict cannot join, so it starts another.
			assert.deepEqual(
				verdicts,
				Array.from({ length: 8 }, () => 'match'),
				`eight at once read ${verdicts}`
			);
		});
	}
);
