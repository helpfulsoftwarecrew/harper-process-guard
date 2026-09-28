# AGENTS.md

For whoever changes this repository. `README.md` is for whoever uses it.

## Rules that are load-bearing

Each of these was paid for once. `README.md` explains what they protect.

- The lock is decided inside a gate one thread holds at a time and is replaced only by `rename`. Check-then-delete let the second thread's delete take the winner's file: 23 of 300 eight-thread races. The race suite runs 60 rounds on Windows, where every identification is a PowerShell start, which still meets that rate several times over.
- The exclusion is bounded by the caller's budget and then broken on purpose; nothing else bounds `claimLock`. At the 5000 ms budget the race suite uses, 0 overlaps in 300 rounds; at 10 ms, 272.
- Nothing is signalled without a positive identification, and "cannot tell" never reads as "not ours", for the lock too: an `unknown` verdict waits out the claim rather than taking the lock.
- The kill path is opt-in and off by default: `stopOrphans`, and launching a reaper at all. A signal sent on a wrong identification cannot be taken back.
- Identity is the command line, never the executable, which resolves to the interpreter for every node script.
- Pid 1 is a process. Inside a container it is usually the host.
- The reaper removes a lock before signalling what it names, and is spawned by path, never imported. Because it removes the lock, a lock that is gone no longer proves a deliberate stop: a joiner whose process died and whose lock is gone restarts the process when the host that held the lock is dead, and leaves the death to that host while it runs.
- A pid the caller's `spawn` hands back is the process only when Node created it for that call (`spawnfile` is set); a wrapper's pid is identified first, and a stranger fails the attempt. Harper's own spawn returns a stale pid file's pid whenever `kill(pid, 0)` answers, and after a restart that is a thread of Harper itself. A pid the platform cannot describe is taken on trust, which on Windows is a CIM lookup that did not answer; that gap is known.
- `spawn` comes from the caller. That is what makes the guard testable with a fake and usable by a host that constrains `child_process`.
- A double stands in for an external boundary only. A test that mocks part of `src/` and asserts how the mock was called is not coverage; it has to assert what a real pid, lock or process did.

A green suite is not a review. A change to `lock.js`, `supervise.js` or `reaper.js` gets an adversarial read, and every new or changed test is mutation-checked by hand: revert the production change, see it go red, restore it.

## Layout

Ten files under `src/`, ESM with `// @ts-check` and JSDoc, nothing built. Four are the lock and what it
arbitrates; the rest are what every consumer of it turned out to need before it could supervise anything at
all, each written inside a consumer first and moved here once it proved to be about supervision rather than
about what the consumer runs.

- `identity.js`: one `inspect()` per pid answering liveness and command line together, one branch per platform. The Windows branch costs a PowerShell start, so `isAlive` never asks for the command line. A lone start took about 400 ms against 3.5 ms for `ps`, and eight at once took 2.9 to 3.6 s apiece on a 2-vCPU `windows-latest` runner, which is what `CIM_TIMEOUT_MS` is sized for.
- `lock.js`: the gate, `adjudicate()` (reads, changes nothing), and the writes: `claimLock`, `commitLock`, `releaseLock`. `safeLockWrite` turns a rejected or superseded write into a message.
- `supervise.js`: start or join, watch, and answer a death by going back through the lock.
- `reaper.js`: the detached script. SIGTERM or SIGINT to it unlinks its own lock first.
- `index.js`: `guard()`, `fingerprint()`, `supervisorFor()` and the two supervisors behind it, plus the re-exports that are the public surface. The reaper is launched before any `verify`: a probe can wait 30 seconds, and a host killed inside that window must not leave its processes behind.
- `exit.js`: one reading per way a process can fail to run or stop running, from `errnoCode` up to `describeExit`, which decides whether a restart would fight an operator. `supervise.js` and a consumer's status endpoint both read it, so they cannot disagree about the same signal.
- `verdict.js`: when a proof stops describing the process that is running. The supervisor rewrites `pid` on the state object a status endpoint is holding, so a verdict taken at boot outlives what it proved. `retakeVerdict` hands the proof a `reason`, because a boot poll can wait 30 seconds for a process just spawned while a retake on the read path holds a status request open.
- `node.js`: the node rather than the thread, in two halves. `claimSingleton` picks one writer for periodic work and `sharedMarks` is a value every thread can read; `nodeProcess`, `currentReaper` and `keepReaperAlive` answer what the node has when a thread's own memory says otherwise.
- `host.js`: the Harper boundary, which is four things a consumer wrote for itself first. `normaliseLog` fills a partial logger, `watchForNeverCalled` catches a host that imports a component and never calls its plugin, `hostRoot` and `resolvePort` read what Harper exposes to nobody, and `writeFiles` is temp-and-rename because every worker thread writes the same files.
- `probe.js`: polling an endpoint or a unix socket until something answers, with a doubling backoff and a `giveUp` for a process that has died. `untraceWith` is how a consumer inside a traced application keeps its own probes out of the host's APM.

Two names were one letter apart and one file had no subject: `supervise.js` supervises a process, and
`supervision.js` was fifteen exports across three ideas. It is gone. Its three parts went to the file that
already owned each idea, which is why `index.js` holds the two supervisors: `bundledSupervisor` is a caller
of `guard()`, and they belong on the same page.

`test/unit/package.test.js` pins the public surface. A name joins it on the test every file above passed: a
consumer needed it, and it is about supervising processes on a Harper node rather than about what those
processes do.

Timings a test needs to wind down live on the context (`tuning`) or in `ReaperOptions`.

## Commands

`npm test` is `node --test`, no build. `npm run typecheck` is `tsc --noEmit`. `test.yml` runs `format:check`, `lint`, `typecheck` and `test` on Linux, macOS and Windows against Node 22 and 24, and `test/unit/package.test.js` reads that workflow so the matrix and the gate cannot drift from what is written here.

Fixtures must not set `process.title`: the command line is the only identity there is. A fixture that has to survive a signal announces itself on stdout first, because it is in the process table before its handler exists.

## Publishing

A hand-pushed `v*` tag runs `publish.yml`: the full matrix, a refusal while `package.json` is private or the tag disagrees with it, then `npm publish` under `next` for a prerelease and `latest` for a stable version. `NPM_TOKEN` is a repository secret: it creates a name on its first publish and writes dist-tags; once the trusted publisher on npmjs.com names this repository and `publish.yml`, the OIDC exchange runs first and provenance comes from it. Provenance is requested explicitly (`NPM_CONFIG_PROVENANCE`), since a publish the token authenticates does not attach it on its own. The tarball is `src/` as written.

A version the registry already holds is not published again, and `latest` is left alone when it already names the version or a newer stable one. The publish check is `npm view name@version`, which reads the packument, and the packument can trail a publish by more than 20 minutes: a re-run of a job that failed after its publish can still fail on the registry's refusal inside that window, and a re-run after it finishes the job.

## Commits

Author, committer and tagger are `HelpfulSoftwareCrew <328022287+helpfulsoftwarecrew@users.noreply.github.com>`, set in the checkout's own git config, with dates in UTC (`TZ=UTC` in the committing command's environment). No commit or tag carries a session trailer or a co-author line. Before a push, `git log --format='%ae%n%ce' | sort -u` prints that one address and nothing else, and `git for-each-ref --format='%(taggeremail)' refs/tags | sort -u` prints it once inside angle brackets (`<328022287+helpfulsoftwarecrew@users.noreply.github.com>`) and nothing else, or nothing at all before the first tag.

## Voice

Comments, commit messages and docs: no em dashes and no hyphen standing in for one, no triads, lead with the claim, stop when it lands. These rules are the whole of the voice; nothing here names a style guide or the tool that wrote a change.
