# harper-process-guard

[![Test](https://github.com/helpfulsoftwarecrew/harper-process-guard/actions/workflows/test.yml/badge.svg)](https://github.com/helpfulsoftwarecrew/harper-process-guard/actions/workflows/test.yml)

One winner per node for a long-lived child process. A host like Harper runs many worker threads in one OS process and evaluates the same component on each of them, so a component that spawns a process starts one per thread unless something arbitrates. This package is the arbiter: a pid lock per process, taken under a file gate and checked by command line, and a detached reaper for what a killed host leaves behind.

Plain ESM, `node:` builtins only, no build step. Node 22.18+ or 24+ on Linux, macOS or Windows.

## Install

```sh
npm install @helpfulsoftwarecrew/harper-process-guard
```

## Use

```js
import { spawn } from 'node:child_process';
import { fingerprint, guard } from '@helpfulsoftwarecrew/harper-process-guard';

const status = await guard({
	pidDir: `${rootPath}/pids`,
	spawn,
	log: logger,
	version: fingerprint(configText, apiKey),
	processes: [
		{
			name: 'trace-agent',
			binaryPath: agentPath,
			args: ['run', '-c', configPath],
			verify: async () => ({ ok: await agentAnswers(), detail: infoUrl }),
		},
	],
	reaper: { name: 'trace-agent-reaper', replacementPidFile: `${rootPath}/hdb.pid` },
});
```

Any subset of a host's threads may make the call, the main thread among them, and the node still runs one process: the first caller starts it and the rest join it and watch it. The call resolves once every declared process is running or has been refused.

- `status.processes`: one state per process, mutated in place for the life of the node, so a status endpoint can hold on to it.
- `status.report`: what this thread's first attempt decided or refused, one line each.
- `status.reaper`: whether one runs, under which pid, and why not if not.
- `status.stop()`: ends this thread's watch, signalling nothing and releasing no lock. Call it on reload. A keeper outlives it: on Linux and macOS a crash after `stop()` is still restarted, and the next `guard()` joins that process, or takes its lock under a new `version`.

| Option           | Default  |                                                                                                      |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `pidDir`         | required | One `<name>.pid` per process. A directory of the guard's own; the reaper takes every lock in it.     |
| `processes`      | required | `name`, `binaryPath`, `args`, and optionally `title`, `exitHint`, `spawnOptions`, `verify`.          |
| `spawn`          | required | The caller's own, so a constrained `child_process` can be passed. It also has to run `node`.         |
| `version`        | `0`      | Fingerprint of whatever forces a replacement. A process under another one is an orphan.              |
| `stopOrphans`    | `false`  | Whether an identified orphan may be sent SIGTERM.                                                    |
| `log`            | silent   | `info`, `warn`, `error`.                                                                             |
| `claimTimeoutMs` | `47000`  | How old another thread's unfinished claim is before it is taken over. `146000` on Windows, as below. |
| `reaper`         | none     | `name`, `graceMs` (8000), `replacementPidFile`, `logFile`, `spawnOptions`. No reaper without it.     |

`verify` runs once everything is up, reaper included, and its verdict lands on the state. A death that nothing restarts, a deliberate stop among them, drops the verdict again, so a status read reports no proof about a process that has gone.

## What it does

**One winner.** The lock is `<pidDir>/<name>.pid`: pid, version fingerprint, and the guard's own record. Every decision is taken inside a `<name>.pid.claiming` gate and the file is replaced by `rename`, so a reader never meets a half-written lock. A dead pid is reclaimed. A claim still unfinished once it is `claimTimeoutMs` old is taken over, which bounds the exclusion rather than making it absolute; how long a waiter has waited never breaks a claim or a gate.

**Identity by command line.** The executable resolves to the interpreter for every node script on the box, so identity is the command line: `/proc` on Linux, `ps` on macOS, `Get-CimInstance Win32_Process` on Windows, compared as a leading run of the process's own argv. Nothing is signalled without a positive match, and a thread does not join a process it cannot identify. A process under a keeper also matches when its parent is the keeper its lock names, because a keeper starts nothing but its process and, on macOS, the `ps` reads it waits on; that is how a binary that execs into another command line under the same pid is still recognised. The parent vouches only while it runs the keeper command line the lock records, which names the lock and its token, so a keeper pid the system has handed to another process vouches for nothing. Nor does pid 1, which adopts every orphan. The keeper also records when the process started, and a pid that still started then is that process whatever it runs, since an exec keeps the start time and a process that reuses the pid has its own; that is what identifies it once its keeper is gone.

**Restart, adopt, stop.** A crash is restarted by the keeper where there is one. Without one, the thread that saw the death goes back through the lock and restarts what nothing else has, or joins what another thread started first. A deliberate exit (code 0, SIGTERM, SIGINT, SIGHUP) releases the lock and restarts nothing. Nor is a death restarted once its keeper has been killed, as below. Restarts wait a second, double, and stop after five.

**The keeper.** On Linux and macOS the thread that wins the lock does not spawn the process itself. It spawns `node` on `src/keeper.js` as a launcher that starts the keeper and exits at once, so init adopts the keeper and the keeper is the process's parent. Only the thread that spawned a process hears how it ended or reaps it, and a host that ends that thread loses both; the keeper outlives any thread. It writes each death to `<name>.pid.exit` beside the lock before it lets the lock go, which is how every thread tells a deliberate stop from a crash. It restarts a crash itself while the lock still carries its token, so a crash is answered with no thread left calling. A thread watching the process joins each pid the keeper commits, and it goes back through the lock only once the lock has changed hands or the keeper is gone. SIGTERM, SIGINT or SIGHUP sent to the keeper is forwarded to the process, and once the process exits the keeper restarts nothing and exits too. A signal sent to the host's whole process group reaches the process twice, once from the group and once through the keeper. A host that will not spawn `node` gets the process spawned by the thread, as before keepers, and a report line saying so.

**A piped stdio.** The other end of a pipe is the thread that spawned the keeper, so where `spawnOptions.stdio` pipes stdout or stderr the keeper holds that pipe and relays the process's output to it. Handed the pipe itself, the process would die on its next write once that thread was gone, and so would every restart. Instead the write fails at the keeper, which drops what the process writes from then on, so the process neither dies nor stalls on a full pipe. On its way out the keeper waits up to a second for relayed output to reach its reader. The thread's end of a piped stdin closes as soon as the launcher exits, so the process gets a stdin of the keeper's instead, which the keeper holds open and never writes: the process reads end-of-file once its keeper is gone and not before, and nothing a thread writes reaches it. The default `stdio` is `'ignore'`.

A keeper killed with SIGKILL, which it cannot forward, leaves its process running with no parent that can read how it ends. A thread still joins that process, identified by the start time the keeper recorded, and restarts nothing when it dies, since from outside a stop and a crash look alike; the next `guard()` call starts it. A process whose output the keeper relayed has lost its pipe's reader with the keeper, and ends on its next write. Under a keeper nothing the guard starts holds the host's event loop open unless `stdio` pipes stdout or stderr, so a host with no other work exits once `guard()` resolves and leaves the process to its keeper, and to the reaper if one was configured. A piped output holds the host open for as long as the keeper holds the pipe's other end, and a process the thread spawns itself, on Windows or where the host refuses `node`, holds it open until the process exits. Where the host is itself pid 1, as in a container with no init, the host adopts each keeper in place of init, and each keeper that exits is left a zombie of the host; run such a host under an init such as `tini` or `docker run --init`.

**Orphans.** A live process whose lock carries this fingerprint and command line is adopted. One under a different fingerprint belongs to an earlier configuration: its lock is taken, and with `stopOrphans` it gets one SIGTERM ahead of the write that stops the lock naming it. Nothing waits and nothing escalates.

**The reaper.** No in-process hook runs when a host is SIGKILLed, so the reaper is a detached process, launched only when `reaper` is passed. It polls the host pid once a second; once the host is gone it waits `graceMs` for a replacement host to record itself in `replacementPidFile`, then removes each lock and signals the pid it names if that pid still identifies. It reads each lock inside the lock's gate as it removes it, so a restart a keeper committed while the reaper was stopping something else is the pid it signals. A keeper that commits after that finds its lock gone and stops what it started, and one whose lock is gone restarts nothing, so what the reaper stops stays stopped. SIGTERM or SIGINT to the reaper logs one line and exits at once, writing nothing into `pidDir`: its lock is left naming a pid that has gone, which the next claim reclaims, since whoever stops a reaper may be removing that directory. It is spawned as `process.execPath` first and a bare `node` second, so a host that filters spawns has to permit one of those. On Linux and macOS what the host spawns is a launcher, which starts the reaper, records its pid on the reaper's lock and exits, so init adopts the reaper: a reaper the host spawned itself could be reaped only by the thread that spawned it, and one that died after the host had replaced that thread was left a zombie of the host. The reaper script has to be reached by its real path: through a symlink, Node resolves the module's own URL and not `process.argv[1]`, so `src/reaper.js` reads itself as imported and runs nothing, and the launch fails with `its launcher ended with exit code 0 and named no pid`.

## Beside the lock

`guard()` is the centre of it, and around it is what a consumer wrote for itself before it was clear none of it
was about the processes it runs. None of it knows what the supervised processes do.

- **Choosing a supervisor.** `supervisorFor(scope, ...)` returns the host's own `scope.processes` where a build carries it and the guard otherwise, decided once so nothing downstream reads the scope twice and disagrees with the first answer. `clearStaleHostPidFiles` removes the host's own pid file where it names a pid something else now holds, which is how a restarted Harper hands a thread of itself back as the process, and where it names a zombie, which Harper's `kill(pid, 0)` reads as running. Given a name's `lock`, it spares a keeper or reaper only when that one carries the lock, since after a restart a keeper of another name can hold the pid.
- **Finding the binary.** Not here. `@helpfulsoftwarecrew/harper-binary-kit/resolve` owns it, beside the staging that writes the module it calls: separately, the two agreed only with themselves.
- **Waiting for it.** `pollEndpoint` and `pollUnixSocket` ask until something answers, backing off and stopping early on a `giveUp` for a process that has died. `untraceWith` is how a consumer running inside a traced application keeps its own startup probes from becoming errored client spans on the host's service. `tailFile` reads the end of a log, which is often the only evidence there is.
- **Reading the host.** `hostRoot` reads the same boot-properties chain Harper reads for itself, because Harper exposes its root path to no component and one that guesses puts its locks under each worker's cwd. `resolvePort` refuses `8126tcp`, which `parseInt` reads as 8126. `writeFiles` is temp-and-rename, because every worker thread writes the same config files and a rereading process must see old or new.
- **One node, many threads.** `claimSingleton` picks one thread to do periodic work, so a timer in a component sends one series instead of one per thread. `sharedMarks` is a small number every thread can read. `readProcess` and `selfProcess` are what the supervised processes cost, from `/proc` where there is one.
- **Verdicts.** A consumer's own proof of health goes stale the moment a restart replaces the pid it was taken against. `takeVerdictAgainst` records which pid one is about, `currentVerdict` says so at read time rather than publishing a dead process's proof, and `retakeVerdict` takes a new one instead of reporting none.
- **Exits.** `describeExit` separates a shutdown from a crash, and `supervise.js` restarts from the same reading a consumer's status endpoint reports, so the two cannot disagree about the same signal. `describeSpawnFailure` names ENOENT, EACCES and ENOEXEC, and leaves a host's own refusal in the host's own words.
- **Lifecycle.** `normaliseLog` fills the levels a partial logger is missing. `createHandleApplication` and `watchForNeverCalled` catch a host that imports a component and never calls its plugin, which the component cannot observe from inside itself.

## Windows

No keeper runs there: Windows leaves no zombie, and no keeper has run on a Windows host. The thread that wins the lock spawns the process as it always did, and only that thread hears how it ended. Once that thread has ended, a thread that joined learns of a death only from its liveness poll, so it goes back through the lock and restarts the process whatever ended it, a clean exit included. With no thread left watching, nothing restarts the process until a thread calls `guard()` again. A pipe in `stdio` has that same thread at its other end, so once the thread has gone the process reads end-of-file on a piped stdin, and a write to a piped output fails. Windows has no SIGPIPE: a node process ends on the unhandled EPIPE, while a native binary is handed an error it may ignore, and need not end. That is read from documentation, not measured on a Windows host. `process.kill` is `TerminateProcess` there: a process an operator stopped is indistinguishable from a crash and is restarted, and a reaper stopped that way leaves its own lock behind. A command-line lookup costs a PowerShell start, and a second one when the first runs out of time, so liveness polls never take one. Everything that identifies a pid pays: a lock claim, a pid a host's spawn handed back, the reaper before it signals, and the node-level reads in `node.js`, `keepReaperAlive`'s check once a minute among them. A thread waiting on another's unfinished claim can sit through several of those in a row, which is why the default `claimTimeoutMs` there is 146 s.

## To do

- The stop and reaper behaviours on Windows above stay until the platform offers a signal a handler can run on.
- Windows has no keeper. Once the thread that started a process has ended, a thread that joined restarts a clean exit as though it were a crash, and with no thread left watching, a crash waits for a thread to call `guard()` again. A keeper there needs a run on a Windows host before it ships.
- The guard is not tied to any one component's agent: `test/unit/package.test.js` fails if a source file names a consumer. A host that is not Harper would say what here is generic and what is Harper-shaped.

## Development

`npm test` spawns real processes and real worker threads, on Linux, macOS and Windows against Node 22 and 24. Read `AGENTS.md` before changing anything under `src/`.
