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

Every thread makes the same call. One starts the process; the rest join it and watch it. The call resolves once every declared process is running or has been refused.

- `status.processes`: one state per process, mutated in place for the life of the node, so a status endpoint can hold on to it.
- `status.report`: what this thread's first attempt decided or refused, one line each.
- `status.reaper`: whether one runs, under which pid, and why not if not.
- `status.stop()`: ends supervision, signalling nothing and releasing no lock. Call it on reload.

| Option           | Default  |                                                                                                  |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `pidDir`         | required | One `<name>.pid` per process. A directory of the guard's own; the reaper takes every lock in it. |
| `processes`      | required | `name`, `binaryPath`, `args`, and optionally `title`, `exitHint`, `spawnOptions`, `verify`.      |
| `spawn`          | required | The caller's own, so a host that hands out a constrained `child_process` can pass it.            |
| `version`        | `0`      | Fingerprint of whatever forces a replacement. A process under another one is an orphan.          |
| `stopOrphans`    | `false`  | Whether an identified orphan may be sent SIGTERM.                                                |
| `log`            | silent   | `info`, `warn`, `error`.                                                                         |
| `claimTimeoutMs` | `30000`  | How long a claim waits on another thread's unfinished one.                                       |
| `reaper`         | none     | `name`, `graceMs` (8000), `replacementPidFile`, `logFile`, `spawnOptions`. No reaper without it. |

`verify` runs once everything is up, reaper included, and its verdict lands on the state.

## What it does

**One winner.** The lock is `<pidDir>/<name>.pid`: pid, version fingerprint, and the guard's own record. Every decision is taken inside a `<name>.pid.claiming` gate and the file is replaced by `rename`, so a reader never meets a half-written lock. A dead pid is reclaimed. A claim that never finishes inside `claimTimeoutMs` is taken over, which bounds the exclusion rather than making it absolute.

**Identity by command line.** The executable resolves to the interpreter for every node script on the box, so identity is the command line: `/proc` on Linux, `ps` on macOS, `Get-CimInstance Win32_Process` on Windows, compared as a leading run of the process's own argv. Nothing is signalled without a positive match, and a thread does not join a process it cannot identify.

**Restart, adopt, stop.** Every death goes back through the lock: the thread that saw it restarts what nothing else has, or joins what another thread started first. A deliberate exit (code 0, SIGTERM, SIGINT, SIGHUP) releases the lock and restarts nothing. Restarts wait a second, double, and stop after five.

**Orphans.** A live process whose lock carries this fingerprint and command line is adopted. One under a different fingerprint belongs to an earlier configuration: its lock is taken, and with `stopOrphans` it gets one SIGTERM ahead of the write that stops the lock naming it. Nothing waits and nothing escalates.

**The reaper.** No in-process hook runs when a host is SIGKILLed, so the reaper is a detached process, launched only when `reaper` is passed. It polls the host pid once a second; once the host is gone it waits `graceMs` for a replacement host to record itself in `replacementPidFile`, then removes each lock and signals the pid it named if the command line still matches. It is spawned as `process.execPath` first and a bare `node` second, so a host that filters spawns has to permit one of those.

## Beside the lock

`guard()` is the centre of it, and around it is what a consumer wrote for itself before it was clear none of it
was about the processes it runs. None of it knows what the supervised processes do.

- **Choosing a supervisor.** `supervisorFor(scope, ...)` returns the host's own `scope.processes` where a build carries it and the guard otherwise, decided once so nothing downstream reads the scope twice and disagrees with the first answer. `clearStaleHostPidFiles` removes the host's own pid file where it names a pid something else now holds, which is how a restarted Harper hands a thread of itself back as the process.
- **Finding the binary.** Not here. `@helpfulsoftwarecrew/harper-binary-kit/resolve` owns it, beside the staging that writes the module it calls: separately, the two agreed only with themselves.
- **Waiting for it.** `pollEndpoint` and `pollUnixSocket` ask until something answers, backing off and stopping early on a `giveUp` for a process that has died. `untraceWith` is how a consumer running inside a traced application keeps its own startup probes from becoming errored client spans on the host's service. `tailFile` reads the end of a log, which is often the only evidence there is.
- **Reading the host.** `hostRoot` reads the same boot-properties chain Harper reads for itself, because Harper exposes its root path to no component and one that guesses puts its locks under each worker's cwd. `resolvePort` refuses `8126tcp`, which `parseInt` reads as 8126. `writeFiles` is temp-and-rename, because every worker thread writes the same config files and a rereading process must see old or new.
- **One node, many threads.** `claimSingleton` picks one thread to do periodic work, so a timer in a component sends one series instead of one per thread. `sharedMarks` is a small number every thread can read. `readProcess` and `selfProcess` are what the supervised processes cost, from `/proc` where there is one.
- **Verdicts.** A consumer's own proof of health goes stale the moment a restart replaces the pid it was taken against. `takeVerdictAgainst` records which pid one is about, `currentVerdict` says so at read time rather than publishing a dead process's proof, and `retakeVerdict` takes a new one instead of reporting none.
- **Exits.** `describeExit` separates a shutdown from a crash, and `supervise.js` restarts from the same reading a consumer's status endpoint reports, so the two cannot disagree about the same signal. `describeSpawnFailure` names ENOENT, EACCES and ENOEXEC, and leaves a host's own refusal in the host's own words.
- **Lifecycle.** `normaliseLog` fills the levels a partial logger is missing. `createHandleApplication` and `watchForNeverCalled` catch a host that imports a component and never calls its plugin, which the component cannot observe from inside itself.

## Windows

`process.kill` is `TerminateProcess` there: a process an operator stopped is indistinguishable from a crash and is restarted, and a reaper stopped that way leaves its own lock behind. A command-line lookup costs a PowerShell start, so liveness polls never take one; only a lock claim and a reap target pay for it.

## To do

- The two Windows behaviours above stay until the platform offers a signal a handler can run on.
- The guard is not tied to any one component's agent: `test/unit/package.test.js` fails if a source file names a consumer. A host that is not Harper would say what here is generic and what is Harper-shaped.

## Development

`npm test` spawns real processes and real worker threads, on Linux, macOS and Windows against Node 22 and 24. Read `AGENTS.md` before changing anything under `src/`.
