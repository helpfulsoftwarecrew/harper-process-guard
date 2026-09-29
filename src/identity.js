// @ts-check
// A process is identified by its command line. /proc/<pid>/exe is kernel-set and unspoofable, and
// useless here: it resolves to the interpreter, so every node script on the box reads identical.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// The error readers live with the other failure readings; exit.js imports nothing from here, so this is safe.
import { errnoCode } from './exit.js';

/**
 * What is known about a pid. 'unknown' is "not established", which is never "not ours".
 *
 * @typedef {'match' | 'differs' | 'unknown'} Verdict
 */

const PS_TIMEOUT_MS = 2000;
// Every thread of a host probes the same lock at once, and eight PowerShell starts in parallel each take
// seconds rather than the fraction of one a lone start takes.
const CIM_TIMEOUT_MS = 10_000;
// A start that timed out gets one more: the first on a cold host may have paid a warm-up the second skips.
const CIM_ATTEMPTS = 2;

/** The longest inspect() can take on `platform`. lock.js holds its gate across an identify, so a waiter that
 * gives up sooner breaks a gate a live thread is inside and both then decide one lock.
 * @param {NodeJS.Platform} [platform] @returns {number} */
export function identifyBudgetMs(platform = process.platform) {
	return platform === 'win32' ? CIM_TIMEOUT_MS * CIM_ATTEMPTS : PS_TIMEOUT_MS;
}
export const IDENTIFY_BUDGET_MS = identifyBudgetMs();
/** The longest isAlive() can take: inspect() makes the read identify makes, except on win32 where kill(pid, 0) answers.
 * @param {NodeJS.Platform} [platform] @returns {number} */
export function aliveBudgetMs(platform = process.platform) {
	return platform === 'win32' ? 0 : identifyBudgetMs(platform);
}
/** The two answers the win32 probe may print, so the script that writes them and the reader below are one protocol. */
const LIVE = 'live';
const GONE = 'gone';

/**
 * The win32 probe's answer, or null when it printed neither. 'live' with nothing after it is a process that
 * exists and would not say what it is, which stays "cannot tell".
 *
 * @param {string} stdout
 * @returns {{ alive: boolean, argv: string[] | null } | null}
 */
export function parseCimAnswer(stdout) {
	// trim() removes the BOM PowerShell prefixes redirected output with, and the trailing CRLF, so the
	// marker is matched against the answer alone.
	const text = stdout.trim();
	if (text === GONE) return { alive: false, argv: null };
	if (text !== LIVE && !text.startsWith(`${LIVE} `)) return null;
	const commandLine = text.slice(LIVE.length).trim();
	return { alive: true, argv: commandLine === '' ? null : [commandLine] };
}

/** @typedef {(command: string, options: import('node:child_process').ExecSyncOptionsWithStringEncoding) => string} ExecSync */

/**
 * The win32 command-line read, exported so a test can stand in for PowerShell. Only a timeout is tried
 * again: any other failure is the host's answer, and a second start would give it again.
 *
 * @param {number} pid One kill(pid, 0) found alive, and an integer, which keeps the shell string safe.
 * @param {ExecSync} [exec]
 * @returns {{ alive: boolean, argv: string[] | null }} argv null is "cannot tell", as it is from inspect().
 */
export function probeCim(pid, exec = execSync) {
	// PowerShell CIM: `wmic` is gone from recent Windows and `tasklist` has no command line. Each call
	// is a PowerShell start, which is why nothing polls it.
	const script =
		`[Console]::OutputEncoding=[Text.Encoding]::UTF8;` +
		`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop;` +
		`if($null -eq $p){'${GONE}'}else{'${LIVE} '+$p.CommandLine}`;
	for (let attempt = 1; ; attempt++) {
		try {
			const stdout = exec(`powershell.exe -NoProfile -NonInteractive -Command "${script}"`, {
				encoding: 'utf-8',
				timeout: CIM_TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			return parseCimAnswer(stdout) ?? { alive: true, argv: null };
		} catch (error) {
			if (errnoCode(error) !== 'ETIMEDOUT' || attempt >= CIM_ATTEMPTS) return { alive: true, argv: null };
		}
	}
}

/**
 * One argument as libuv's quote_cmd_arg writes it into a Windows command line. Windows keeps no argv, so a
 * recorded vector is quoted the way it was to compare against what Windows kept.
 *
 * @param {string} argument
 * @returns {string}
 */
function quoteForWindows(argument) {
	if (argument.length === 0) return '""';
	if (!/[ \t"]/.test(argument)) return argument;
	if (!/["\\]/.test(argument)) return `"${argument}"`;
	let escaped = '';
	let backslashes = 0;
	for (const character of argument) {
		if (character === '\\') {
			backslashes += 1;
			continue;
		}
		// A run of backslashes is doubled only where it meets a quote, the closing one below included.
		escaped += character === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${character}`;
		backslashes = 0;
	}
	return `"${escaped}${'\\'.repeat(backslashes * 2)}"`;
}

/** The command line Windows reports for a process node spawned with `argv`. @param {readonly string[]} argv @returns {string} */
export function windowsCommandLine(argv) {
	return argv.map(quoteForWindows).join(' ');
}

/**
 * Whether a pid still runs and what its command line is, answered by one read where one read answers both.
 * A zombie counts as gone; 0 and negatives are refused, since kill(2) reads those as process groups.
 *
 * @param {number} pid
 * @param {boolean} [withCommandLine] False asks liveness alone, which skips a PowerShell on win32 and changes nothing elsewhere.
 * @returns {{ alive: boolean, argv: string[] | null }} argv null is "cannot tell", never "no arguments".
 */
function inspect(pid, withCommandLine = true) {
	if (!Number.isInteger(pid) || pid <= 0) return { alive: false, argv: null };
	try {
		process.kill(pid, 0);
	} catch (error) {
		// EPERM counts as alive: it exists, owned by another user.
		if (errnoCode(error) !== 'EPERM') return { alive: false, argv: null };
	}
	try {
		if (process.platform === 'linux') {
			// comm is parenthesised and may hold spaces and parens, so state is the token after the LAST ')'.
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
			if (
				stat
					.slice(stat.lastIndexOf(')') + 1)
					.trim()
					.startsWith('Z')
			)
				return { alive: false, argv: null };
			// NUL-separated with a trailing NUL. Empty for a kernel thread, and for an unreadable argv area.
			const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
			return { alive: true, argv: raw === '' ? null : raw.replace(/\0$/, '').split('\0') };
		}
		if (process.platform === 'darwin') {
			// execSync is the only sync spawn Harper's constrained child_process keeps. Safe as a shell string
			// only because pid was checked an integer above.
			const [state, ...argv] = execSync(`ps -p ${pid} -o state=,args=`, {
				encoding: 'utf-8',
				timeout: PS_TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
				.trim()
				.split(/\s+/);
			if (state === undefined) return { alive: false, argv: null };
			if (state.startsWith('Z')) return { alive: false, argv: null };
			// `ps` joined the vector with single spaces already, which is why compareArgv compares joined text.
			return { alive: true, argv: argv.length > 0 ? argv : null };
		}
		if (process.platform === 'win32') {
			// Liveness never reaches the probe: libuv's kill(pid, 0) already answered it above.
			if (!withCommandLine) return { alive: true, argv: null };
			return probeCim(pid);
		}
	} catch {
		// Liveness was answered by kill(pid, 0); a command line nothing can read is "cannot tell".
		return { alive: true, argv: null };
	}
	// Any other platform. A caller that cannot see must do nothing and say why.
	return { alive: true, argv: null };
}

/** @param {number} pid */
export function isAlive(pid) {
	// A process cannot be a zombie to itself, and the command line is not part of this question.
	return pid === process.pid || inspect(pid, false).alive;
}

/** Cadence for a wait measured in seconds. Each pass costs a `ps` on darwin, so tighter forks hundreds of
 * times and buys nothing. */
export const STOP_POLL_MS = 50;

/** Poll until `pid` is gone or `deadline` passes. Shared, so a grace period is one loop and not one per
 * caller. @param {number} pid @param {number} deadline @param {number} pollMs */
export async function waitWhileAlive(pid, deadline, pollMs) {
	while (Date.now() < deadline && isAlive(pid)) await delay(pollMs);
}

/**
 * On darwin and win32 the whole command line in ONE element, which is all either reports. Never an
 * expectation for identify(): win32 re-quotes what it is handed and a joined line does not survive that.
 *
 * @param {number} pid @returns {string[] | null}
 */
export function argvOf(pid) {
	return inspect(pid).argv;
}

/**
 * `expected` is a LEADING RUN of the pid's argv, so pinning more can only narrow a verdict. An empty one
 * describes no process and identifies none.
 *
 * @param {readonly string[] | null} actual
 * @param {readonly string[]} expected
 * @returns {Verdict}
 */
export function compareArgv(actual, expected) {
	if (expected.length === 0 || actual === null) return 'unknown';
	if (process.platform === 'darwin' || process.platform === 'win32') {
		// Joined: both report one string and re-splitting reads a spaced argument as two. The trailing space
		// keeps `--conf` from matching a prefix of `--config`.
		const head = actual.join(' ');
		const want = process.platform === 'win32' ? windowsCommandLine(expected) : expected.join(' ');
		return head === want || head.startsWith(`${want} `) ? 'match' : 'differs';
	}
	return expected.every((argument, index) => actual[index] === argument) ? 'match' : 'differs';
}

/** @param {number} pid @param {readonly string[]} expected @returns {Verdict} */
export function identify(pid, expected) {
	const { alive, argv } = inspect(pid);
	return alive ? compareArgv(argv, expected) : 'differs';
}
