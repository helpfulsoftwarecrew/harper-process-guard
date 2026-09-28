// Ignores SIGTERM so the escalation to SIGKILL has something to escalate against, POSIX only. "ready" goes
// out once the handler exists, since the pid is in the process table long before the script runs.
process.on('SIGTERM', () => {});
setInterval(() => {}, 1 << 30);
process.stdout.write('ready\n');
