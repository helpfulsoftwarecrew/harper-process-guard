// @ts-check
// The reaper signals things, so the cases that matter are the ones where it must not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { fileURLToPath } from 'node:url';

import { argvOf, isAlive, startedAt } from '../../src/identity.js';
import { claimLock, lockPath, readLock } from '../../src/lock.js';
import { collectTargets, parseArgs, reapTarget, replacementPid, run } from '../../src/reaper.js';
import {
	anotherStart,
	deadPid,
	fixture,
	pidOf,
	readyLine,
	seedLock,
	skipOnWindows,
	slow,
	waitFor,
	withSpawn,
	withTempDir,
} from '../support/harness.js';

const REAPER_SCRIPT = fileURLToPath(new URL('../../src/reaper.js', import.meta.url));

/** @param {string} dir @param {Partial<import('../../src/reaper.js').ReaperOptions>} [overrides] */
const options = (dir, overrides = {}) => ({ hostPid: process.pid, pidDir: dir, graceMs: 0, ...overrides });

/** @param {import('../../src/supervise.js').Spawn} spawn @param {string} tag */
async function running(spawn, tag) {
	const argv = [process.execPath, fixture('idle.js'), tag];
	const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
	await waitFor(() => argvOf(pidOf(child)) !== null, 'the process to appear in the process table');
	return { child, argv, pid: pidOf(child) };
}

test('only locks this guard wrote are targets: a host pid file and an unrecorded lock are neither', () =>
	withTempDir('guard-reap-', (dir) => {
		// A host's own pid file shares this directory. Reading it as a target would kill the host.
		fs.writeFileSync(path.join(dir, 'hdb.pid'), '4242\n');
		fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a lock at all');
		seedLock(lockPath(dir, 'no-argv'), { pid: 77, argv: [] });
		seedLock(lockPath(dir, 'mine'), { pid: 88, argv: ['/bin/thing', '--flag'] });
		seedLock(lockPath(dir, 'self'), { pid: 99, argv: ['/bin/reaper'] });

		const targets = collectTargets(options(dir, { selfLock: lockPath(dir, 'self') }));
		assert.deepEqual(targets, [{ path: lockPath(dir, 'mine'), pid: 88, argv: ['/bin/thing', '--flag'] }]);
	}));

test('a lock whose pid is running something else loses its lock and keeps its process', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const stranger = await running(spawn, 'not-ours');
			// A pid reused by something this node never started, which is routine in a container.
			seedLock(lockPath(dir, 'reused'), { pid: stranger.pid, argv: [process.execPath, '/gone.js'] });

			await reapTarget(options(dir), collectTargets(options(dir))[0] ?? assert.fail('no target'));
			assert.equal(fs.existsSync(lockPath(dir, 'reused')), false);
			assert.equal(isAlive(stranger.pid), true, 'the reaper signalled a process it had not identified');
		})
	));

test('an identified process is stopped, and its lock goes before the signal does', (t) => {
	if (
		skipOnWindows(
			t,
			'nothing on Windows can ignore a terminate, so neither the window between the lock going and the process ' +
				'going nor the escalation from SIGTERM to SIGKILL is observable; both go uncovered there.'
		)
	)
		return;
	return withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// Ignores SIGTERM, so the window between the lock going and the process going is observable.
			const argv = [process.execPath, fixture('stubborn.js'), 'stubborn'];
			const child = spawn(process.execPath, argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
			assert.equal(await readyLine(child), 'ready');
			seedLock(lockPath(dir, 'stubborn'), { pid: pidOf(child), argv });

			const reaping = reapTarget(options(dir, { termGraceMs: 300 }), {
				path: lockPath(dir, 'stubborn'),
				pid: pidOf(child),
				argv,
			});
			// Nothing is awaited between the call and these, because the order within one step is the claim.
			assert.equal(fs.existsSync(lockPath(dir, 'stubborn')), false, 'the process was signalled before its lock went');
			assert.equal(isAlive(pidOf(child)), true, 'the process went before its lock did');

			await reaping;
			// kill(2) returns once the signal is queued, so the death is waited for rather than assumed.
			await waitFor(() => !isAlive(pidOf(child)), 'the process that ignored SIGTERM to be escalated to SIGKILL and go');
		})
	);
});

test("NEGATIVE: a process running the lock's command line under another start time than the lock records is left alone", (t) => {
	if (skipOnWindows(t, 'no keeper runs on win32, so no lock there records a start time')) return;
	return withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// Another start of the same command, holding a pid the locked process once had.
			const other = await running(spawn, 'same-command-another-start');
			const started = startedAt(other.pid) ?? assert.fail('no start time was read');
			seedLock(lockPath(dir, 'reused'), { pid: other.pid, argv: other.argv, started: anotherStart(started) });

			await reapTarget(options(dir), collectTargets(options(dir))[0] ?? assert.fail('no target'));
			assert.equal(fs.existsSync(lockPath(dir, 'reused')), false);
			assert.equal(
				isAlive(other.pid),
				true,
				'the reaper signalled a process that started after the one its lock records'
			);
		})
	);
});

test('a lock that names no pid is removed, and the process it half-recorded is not signalled', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// A host killed between spawn and commit leaves pid 0, and nothing adopts through that lock's argv.
			const claimed = await running(spawn, 'never-committed');
			seedLock(lockPath(dir, 'uncommitted'), { pid: 0, argv: claimed.argv });

			await reapTarget(options(dir), collectTargets(options(dir))[0] ?? assert.fail('no target'));
			assert.equal(fs.existsSync(lockPath(dir, 'uncommitted')), false, 'a lock naming no pid was left behind');
			assert.equal(isAlive(claimed.pid), true, 'pid 0 was signalled, which names this process group');
		})
	));

test('a lock naming a pid nothing holds is removed and nothing is signalled', () =>
	withTempDir('guard-reap-', async (dir) => {
		const gone = await deadPid();
		seedLock(lockPath(dir, 'stale'), { pid: gone, argv: [process.execPath, '/whatever.js'] });
		await reapTarget(options(dir), {
			path: lockPath(dir, 'stale'),
			pid: gone,
			argv: [process.execPath, '/whatever.js'],
		});
		assert.equal(fs.existsSync(lockPath(dir, 'stale')), false);
	}));

test('a lock is reaped for the pid it names when it is reaped, not the one it named when the reaper listed it', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const argv = [process.execPath, fixture('idle.js'), `recommitted-${process.pid}`];
			seedLock(lockPath(dir, 'recommitted'), { pid: await deadPid(), argv });
			const [listed] = collectTargets(options(dir));
			// A keeper commits the restart it owes between the reaper's listing and its turn at this lock.
			const restarted = await running(spawn, argv[2] ?? '');
			seedLock(lockPath(dir, 'recommitted'), { pid: restarted.pid, argv });

			await reapTarget(options(dir, { termGraceMs: 300 }), listed ?? assert.fail('no target'));
			assert.equal(fs.existsSync(lockPath(dir, 'recommitted')), false);
			assert.equal(isAlive(restarted.pid), false, 'the pid the lock named at reaping outlived the reaper');
		})
	));

test('when the host goes and nothing replaces it, everything it locked is stopped', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const guarded = await running(spawn, 'reaped');
			seedLock(lockPath(dir, 'guarded'), { pid: guarded.pid, argv: guarded.argv });
			const host = await running(spawn, 'the-host');
			// run() here is this process, so its own lock names this pid.
			seedLock(lockPath(dir, 'self'), { pid: process.pid, argv: ['/bin/reaper'] });

			host.child.kill('SIGKILL');
			await waitFor(() => !isAlive(host.pid), 'the host to go');
			await run(options(dir, { hostPid: host.pid, graceMs: 50, termGraceMs: 500, selfLock: lockPath(dir, 'self') }));

			assert.equal(isAlive(guarded.pid), false, 'a process outlived the host it was locked under');
			assert.equal(fs.existsSync(lockPath(dir, 'guarded')), false);
			assert.equal(fs.existsSync(lockPath(dir, 'self')), false, 'the reaper left its own lock behind');
		})
	));

test('NEGATIVE: a reaper leaves its lock to the newer reaper that took it, whether or not a host replaced its own', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// A host that replaced this reaper's took the name for its own reaper, which the lock now names.
			const newer = await running(spawn, 'the-newer-reaper');
			const host = await running(spawn, 'the-old-host');
			host.child.kill('SIGKILL');
			await waitFor(() => !isAlive(host.pid), 'the old host to go');
			const self = lockPath(dir, 'self');
			const hostFile = path.join(dir, 'host.pid');
			const reaper = (/** @type {string | undefined} */ replacementPidFile) =>
				run(
					options(dir, {
						hostPid: host.pid,
						graceMs: 50,
						selfLock: self,
						...(replacementPidFile ? { replacementPidFile } : {}),
					})
				);

			seedLock(self, { pid: newer.pid, argv: newer.argv });
			await reaper(undefined);
			assert.equal(
				readLock(self)?.pid,
				newer.pid,
				"a reaper whose host nothing replaced removed the newer reaper's lock"
			);

			const replacement = await running(spawn, 'the-new-host');
			fs.writeFileSync(hostFile, `${replacement.pid}\n`);
			await reaper(hostFile);
			assert.equal(
				readLock(self)?.pid,
				newer.pid,
				"a reaper handing over to a replacement removed the newer reaper's lock"
			);

			seedLock(self, { pid: process.pid, argv: ['/bin/reaper'] });
			await reaper(hostFile);
			assert.equal(fs.existsSync(self), false, 'a reaper handing over left its own lock behind');
		})
	));

/**
 * A reaper spawned by path, watching this process, once its first log line proves its signal handlers exist.
 * @param {import('../../src/supervise.js').Spawn} spawn @param {string} pidDir @param {string} log
 */
async function startReaper(spawn, pidDir, log) {
	const self = lockPath(pidDir, 'self');
	const args = [
		REAPER_SCRIPT,
		'--host-pid',
		String(process.pid),
		'--pid-dir',
		pidDir,
		'--self-lock',
		self,
		'--log',
		log,
	];
	const reaper = spawn(process.execPath, args, { stdio: 'ignore' });
	/** @type {Promise<unknown>} */
	const exited = new Promise((resolve) => reaper.once('exit', resolve));
	const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '');
	await waitFor(() => logged().includes('watching pid'), 'the reaper to start');
	seedLock(self, { pid: pidOf(reaper), argv: [process.execPath, ...args] });
	return { reaper, exited, self, logged };
}

const NO_SIGTERM = 'a Windows process cannot be sent SIGTERM, so the reaper runs no handler there to test.';

test('a reaper told to stop exits and writes nothing more when its pid directory has already gone', (t) => {
	if (skipOnWindows(t, NO_SIGTERM)) return;
	return withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// A host tearing down removes the pid directory while the reaper it is stopping still runs.
			const pidDir = path.join(dir, 'pids');
			fs.mkdirSync(pidDir);
			const { reaper, exited, logged } = await startReaper(spawn, pidDir, path.join(dir, 'reaper.log'));
			fs.rmSync(pidDir, { recursive: true, force: true });
			reaper.kill('SIGTERM');
			await exited;
			const lines = logged().trim().split('\n');
			assert.equal(lines.length, 2, `a vanished lock was logged as more than a stop: ${lines.slice(1).join(' | ')}`);
			assert.match(lines[1] ?? '', /received SIGTERM/);
			assert.doesNotMatch(
				lines[1] ?? '',
				/could not release/,
				'a lock whose directory had gone was logged as an error'
			);
		})
	);
});

test('a reaper told to stop exits at once rather than wait on a gate another process holds', (t) => {
	if (skipOnWindows(t, NO_SIGTERM)) return;
	return withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const { reaper, exited, self } = await startReaper(spawn, dir, path.join(dir, 'reaper.log'));
			// A live process holds the gate: this one, which never lets go of it.
			fs.writeFileSync(`${self}.claiming`, String(process.pid));
			const signalled = Date.now();
			reaper.kill('SIGTERM');
			await exited;
			const took = Date.now() - signalled;
			assert.ok(took < 1000, `the reaper outlived SIGTERM by ${took} ms waiting on a gate`);
			// Left naming a pid that has gone, which the next claim reclaims once the gate is free.
			assert.equal(readLock(self)?.pid, pidOf(reaper));
			assert.equal(isAlive(pidOf(reaper)), false);
			fs.unlinkSync(`${self}.claiming`);
			const claim = await claimLock({
				pidDir: dir,
				name: 'self',
				version: 1,
				argv: ['/bin/reaper'],
				timeoutMs: slow(5000),
			});
			assert.equal(claim.outcome, 'won');
			assert.match(claim.outcome === 'won' ? claim.notes.join('\n') : '', /reclaimed the lock from pid/);
		})
	);
});

test('NEGATIVE: a reaper told to stop leaves its lock to the newer reaper that took it', (t) => {
	if (skipOnWindows(t, 'a Windows process cannot be sent SIGTERM, so the reaper runs no handler there to test.'))
		return;
	return withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const self = lockPath(dir, 'self');
			const log = path.join(dir, 'reaper.log');
			const args = [
				REAPER_SCRIPT,
				'--host-pid',
				String(process.pid),
				'--pid-dir',
				dir,
				'--self-lock',
				self,
				'--log',
				log,
			];
			const reaper = spawn(process.execPath, args, { stdio: 'ignore' });
			const exited = new Promise((resolve) => reaper.once('exit', resolve));
			// Its first log line proves the signal handler exists.
			await waitFor(
				() => fs.existsSync(log) && fs.readFileSync(log, 'utf-8').includes('watching pid'),
				'the reaper to start'
			);
			const newer = await running(spawn, 'the-newer-reaper');
			seedLock(self, { pid: newer.pid, argv: newer.argv });

			reaper.kill('SIGTERM');
			await exited;
			assert.equal(readLock(self)?.pid, newer.pid, "a reaper told to stop removed the newer reaper's lock");
		})
	);
});

test('a reaper whose pid directory has gone by the time its host does logs no error about its lock', () =>
	withTempDir('guard-reap-', async (dir) => {
		// A host tearing down removed the directory; the lock went with it, which is the outcome the release wants.
		const gone = path.join(dir, 'pids');
		const log = path.join(dir, 'reaper.log');
		await run(options(gone, { hostPid: await deadPid(), selfLock: lockPath(gone, 'self'), logFile: log }));
		assert.doesNotMatch(fs.readFileSync(log, 'utf-8'), /could not release/);
		assert.match(fs.readFileSync(log, 'utf-8'), /done\./);
	}));

test('a replacement host inside the grace window keeps the processes for it to adopt', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const guarded = await running(spawn, 'handed-over');
			seedLock(lockPath(dir, 'guarded'), { pid: guarded.pid, argv: guarded.argv });
			const host = await running(spawn, 'the-old-host');
			const replacement = await running(spawn, 'the-new-host');

			host.child.kill('SIGKILL');
			await waitFor(() => !isAlive(host.pid), 'the old host to go');
			// A restart forks a replacement and exits the old host, so the processes stay for it to adopt.
			const hostFile = path.join(dir, 'host.pid');
			fs.writeFileSync(hostFile, `${replacement.pid}\n`);

			await run(options(dir, { hostPid: host.pid, graceMs: 5000, replacementPidFile: hostFile }));
			assert.equal(isAlive(guarded.pid), true, 'a handover stopped the process the replacement was to adopt');
			assert.equal(fs.existsSync(lockPath(dir, 'guarded')), true);
		})
	));

test('the replacement file naming the host that just died is not a replacement', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const guarded = await running(spawn, 'not-handed-over');
			seedLock(lockPath(dir, 'guarded'), { pid: guarded.pid, argv: guarded.argv });
			const host = await running(spawn, 'the-only-host');

			host.child.kill('SIGKILL');
			await waitFor(() => !isAlive(host.pid), 'the host to go');
			const hostFile = path.join(dir, 'host.pid');
			fs.writeFileSync(hostFile, `${host.pid}\n`);

			await run(options(dir, { hostPid: host.pid, graceMs: 50, termGraceMs: 500, replacementPidFile: hostFile }));
			assert.equal(isAlive(guarded.pid), false, 'a stale host pid file was read as a live replacement');
		})
	));

test('only a live pid that is not the host that just died is read as a replacement', () =>
	withTempDir('guard-reap-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// process.pid stands in for a recycled pid, since isAlive answers true for it with nothing to keep up.
			const hostFile = path.join(dir, 'host.pid');
			const reaper = (/** @type {number} */ hostPid) =>
				replacementPid(options(dir, { hostPid, replacementPidFile: hostFile }));

			fs.writeFileSync(hostFile, `${process.pid}\n`);
			assert.equal(
				reaper(process.pid),
				null,
				"the old host's own pid, handed back out by the OS, read as a replacement"
			);

			fs.writeFileSync(hostFile, `${await deadPid()}\n`);
			assert.equal(reaper(process.pid), null, 'a pid file an earlier host left behind read as a replacement');

			const other = await running(spawn, 'a-real-replacement');
			fs.writeFileSync(hostFile, `${other.pid}\n`);
			assert.equal(reaper(process.pid), other.pid, 'a live replacement that is not the old host was refused');
		})
	));

test('every flag is read, and one arriving without a value consumes nothing', () => {
	assert.deepEqual(
		parseArgs([
			'--host-pid',
			'5',
			'--pid-dir',
			'/locks',
			'--grace-ms',
			'7',
			'--replacement-pid-file',
			'/host.pid',
			'--self-lock',
			'/locks/self.pid',
			'--log',
			'/reaper.log',
		]),
		{
			hostPid: 5,
			pidDir: '/locks',
			graceMs: 7,
			replacementPidFile: '/host.pid',
			selfLock: '/locks/self.pid',
			logFile: '/reaper.log',
		}
	);
	assert.deepEqual(parseArgs(['--host-pid', '5', '--log']), { hostPid: 5, pidDir: '', graceMs: 8000 });
});
