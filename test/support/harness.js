// @ts-check
// Shared scaffolding: temp directories, real child processes, and a spawn that records what it was asked for.
import { spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WINDOWS = process.platform === 'win32';

/** test/support sits two levels below the repo root. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');
/** A path rather than an import, so this harness also loads against a source tree that has no keeper. */
export const KEEPER_SCRIPT = path.join(REPO_ROOT, 'src', 'keeper.js');

/** @param {string} name @returns {string} */
export const fixture = (name) => path.join(FIXTURES, name);

/**
 * Headroom for the Windows runner, slower at process and file work, where a command-line lookup costs a
 * process start. A factor, so every wait keeps its ratio to every other.
 *
 * @param {number} ms
 */
export const slow = (ms) => (WINDOWS ? ms * 4 : ms);

/**
 * Skip on Windows, naming what goes uncovered there. Returns whether it skipped, so the caller returns
 * rather than running on: a skip whose reason is unstated reads as a pass.
 *
 * @param {import('node:test').TestContext} t @param {string} reason @returns {boolean}
 */
export function skipOnWindows(t, reason) {
	if (!WINDOWS) return false;
	t.skip(reason);
	return true;
}

/**
 * Skip where no permission bit can stop a write, naming what goes uncovered. A uid 0 process holds
 * CAP_DAC_OVERRIDE, so chmod cannot make a directory refuse it, and every root container runs as uid 0.
 *
 * @param {import('node:test').TestContext} t @param {string} reason @returns {boolean}
 */
export function skipAsRoot(t, reason) {
	if (process.getuid?.() !== 0) return false;
	t.skip(reason);
	return true;
}

/**
 * mkdtemp pre-resolved: the macOS tmpdir sits behind /var -> /private/var and the Windows one can come
 * back as an 8.3 short path, and these suites compare paths against a process table that holds neither.
 *
 * @param {string} prefix
 */
function makeTempDir(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * A temp dir around `run`, removed however it ends. A test must RETURN this call: a fire-and-forget
 * rejection is held by nobody and the test passes.
 *
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T | Promise<T>} run
 * @returns {Promise<Awaited<T>>}
 */
export async function withTempDir(prefix, run) {
	const dir = makeTempDir(prefix);
	try {
		return await run(dir);
	} finally {
		await stopProcessesNaming(dir);
		// Retried on Windows, where nothing above runs and unlink refuses a file another process still holds
		// open: a reaper this test started may not have closed its log yet.
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: WINDOWS ? 10 : 0, retryDelay: 50 });
	}
}

/** Every process as `ps` lists it, POSIX only. @returns {{ pid: number, ppid: number, stat: string, args: string }[]} */
export function processTable() {
	const table = realSpawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,args='], { encoding: 'utf-8' });
	if (table.error || table.status !== 0)
		throw new Error(`the process table could not be read: ${table.error ?? `exit ${table.status}`}`);
	return table.stdout.split('\n').flatMap((line) => {
		const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), stat: row[3] ?? '', args: row[4] ?? '' }] : [];
	});
}

/**
 * Every process whose command line names `dir`, keepers and reapers alike, and each one's children, killed. All are
 * frozen first, so none restarts what a test's cleanup killed or writes into `dir` between the listing and the kill.
 *
 * @param {string} dir
 */
async function stopProcessesNaming(dir) {
	if (WINDOWS) return;
	// A keeper or a reaper leaves a lock, a record or a log behind, and a directory with none is spared a `ps`.
	const entries = fs.readdirSync(dir, { recursive: true }).map(String);
	if (!entries.some((entry) => entry.endsWith('.pid') || entry.endsWith('.exit') || entry.endsWith('.log'))) return;
	for (let round = 0; round < 5; round++) {
		// A reaper appends to its log after it has stopped everything, and that write once landed inside rmSync.
		const named = processTable().filter((row) => namesDir(row.args, dir) && row.pid !== process.pid);
		if (named.length === 0) return;
		for (const { pid } of named) signalQuietly(pid, 'SIGSTOP');
		await new Promise((resolve) => setTimeout(resolve, 20));
		const frozen = new Set(named.map((row) => row.pid));
		const children = processTable().filter((row) => frozen.has(row.ppid));
		for (const { pid } of [...children, ...named]) signalQuietly(pid, 'SIGKILL');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Whether a command line names `dir` or a path inside it, and not a sibling that merely starts the same way.
 * @param {string} args @param {string} dir */
const namesDir = (args, dir) => args.includes(`${dir}${path.sep}`) || args.includes(`${dir} `) || args.endsWith(dir);

/** @param {number} pid @param {NodeJS.Signals} signal */
function signalQuietly(pid, signal) {
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone, which is the outcome asked for.
	}
}

/**
 * Poll `predicate` until it holds, or throw naming what never happened. Never returns false: a test
 * that silently gave up would read as a pass.
 *
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {string} what
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitFor(predicate, what, { timeoutMs = slow(10_000), intervalMs = 10 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** A window for something to happen in, given to a test whose claim is that nothing did. @param {number} ms */
export function settle(ms) {
	return new Promise((resolve) => setTimeout(resolve, slow(ms)));
}

/** A pid no platform issues: Linux stays below 2^22, macOS below 100000, and Windows issues multiples of four. For a
 * lock that must name a dead process for a whole test, since a freed pid can be issued again inside one. */
export const UNISSUED_PID = 2 ** 22 + 1;

/** A pid nothing holds: a real process, run to completion and reaped, so the number was genuinely issued. */
export async function deadPid() {
	const child = realSpawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
	await once(child, 'exit');
	if (typeof child.pid !== 'number') throw new Error('the throwaway process reported no pid');
	return child.pid;
}

/** Lines by level, so a test can assert what was said rather than that something was. */
export function captureLog() {
	/** @type {{ info: string[], warn: string[], error: string[] }} */
	const lines = { info: [], warn: [], error: [] };
	return {
		lines,
		all: () => [...lines.info, ...lines.warn, ...lines.error],
		info: (/** @type {string} */ m) => lines.info.push(m),
		warn: (/** @type {string} */ m) => lines.warn.push(m),
		error: (/** @type {string} */ m) => lines.error.push(m),
	};
}

/**
 * Real children through a spawn that records its calls, all killed however `run` ends. Real, because
 * a fake child has no pid the identification can read and no argv anything can be counted by.
 *
 * @template T
 * @param {(tools: { spawn: import('../../src/supervise.js').Spawn, calls: { command: string, args: string[], options: import('node:child_process').SpawnOptions & { name?: string } }[], children: import('node:child_process').ChildProcess[] }) => T | Promise<T>} run
 * @returns {Promise<Awaited<T>>}
 */
export async function withSpawn(run) {
	/** @type {import('node:child_process').ChildProcess[]} */
	const children = [];
	/** @type {{ command: string, args: string[], options: import('node:child_process').SpawnOptions & { name?: string } }[]} */
	const calls = [];
	/** @type {import('../../src/supervise.js').Spawn} */
	const spawn = (command, args, options) => {
		const child = realSpawn(command, args, options);
		children.push(child);
		calls.push({ command, args, options });
		return child;
	};
	try {
		return await run({ spawn, calls, children });
	} finally {
		for (const child of children) {
			// Only one that started. A child whose spawn failed still holds a handle whose pid is 0, and
			// libuv passes that straight to kill(2), which signals the whole process group, this runner included.
			if (!child.pid) continue;
			try {
				child.kill('SIGKILL');
			} catch {
				// Already gone, which is the outcome asked for.
			}
		}
	}
}

/**
 * The supervision timings wound down, so a restart test measures the behaviour rather than the backoff
 * schedule. Every millisecond goes through slow(); restartMax is a count and does not.
 *
 * @param {Partial<import('../../src/supervise.js').Tuning>} [overrides]
 * @returns {import('../../src/supervise.js').Tuning}
 */
export function tuning({ deathPollMs = 20, restartMax = 5, restartBaseMs = 10 } = {}) {
	return { deathPollMs: slow(deathPollMs), restartMax, restartBaseMs: slow(restartBaseMs) };
}

/**
 * A supervise Context with those timings.
 *
 * @param {string} pidDir
 * @param {import('../../src/supervise.js').Spawn} spawn
 * @param {Omit<Partial<import('../../src/supervise.js').Context>, 'log'>} [overrides]
 * @returns {import('../../src/supervise.js').Context & { log: ReturnType<typeof captureLog> }}
 */
export function context(pidDir, spawn, overrides = {}) {
	return {
		pidDir,
		spawn,
		version: 1,
		stopOrphans: false,
		log: captureLog(),
		claimTimeoutMs: slow(5000),
		report: [],
		run: { stopping: false },
		tuning: tuning(),
		...overrides,
	};
}

/**
 * A lock as this guard writes it: pid on line 1, version on line 2, the guard's own record on line 3.
 * Written by hand rather than through the module under test, so a broken writer cannot seed a passing test.
 *
 * @param {string} file
 * @param {{ pid: number, version?: number, token?: string, host?: number, argv?: readonly string[], keeper?: number, keeperArgv?: readonly string[] }} lock
 */
export function seedLock(file, { pid, version = 1, token = 'seeded', host = 1, argv = [], keeper, keeperArgv = [] }) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const kept = keeper === undefined ? {} : { keeper, keeperArgv };
	fs.writeFileSync(file, `${pid}\n${version}\n${JSON.stringify({ token, host, argv, ...kept })}\n`, 'utf-8');
}

/**
 * Every command line running on this machine, one per line. Windows has no `ps`, so there each call is a
 * PowerShell start, which is why nothing polls this; Get-CimInstance, since wmic.exe is gone.
 */
function commandLines() {
	const table = WINDOWS
		? realSpawnSync(
				'powershell.exe',
				[
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
				],
				{ encoding: 'utf-8' }
			)
		: realSpawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf-8' });
	// A query that failed would otherwise read as "nothing is running", which is a passing answer to some
	// of the questions asked here.
	if (table.error || table.status !== 0)
		throw new Error(`the process table could not be read: ${table.error ?? `exit ${table.status}`}`);
	return table.stdout;
}

/**
 * Windows quotes a whole argument that holds a space and adds nothing else, so dropping every quote
 * compares the same words `ps` has already joined with single spaces. No argv in this suite contains one.
 *
 * @param {string} line
 */
const asCommandLine = (line) => (WINDOWS ? line.replaceAll('"', '') : line).trim().replace(/\s+/g, ' ');

/**
 * How many processes on this machine are running exactly this command line. Counted from the process
 * table rather than from the guard's own bookkeeping, because the bookkeeping is what is under test.
 *
 * @param {readonly string[]} argv
 */
export function countRunning(argv) {
	const wanted = asCommandLine(argv.join(' '));
	return commandLines()
		.split('\n')
		.filter((line) => asCommandLine(line) === wanted).length;
}

/** The first line a fixture writes once it is doing its job, so nothing signals it too early. @param {import('node:child_process').ChildProcess} child */
export function readyLine(child) {
	return new Promise((resolve) => child.stdout?.once('data', (chunk) => resolve(String(chunk).trim())));
}

/** @param {import('node:child_process').ChildProcess} child */
export function pidOf(child) {
	if (typeof child.pid !== 'number') throw new Error('the child reported no pid');
	return child.pid;
}
