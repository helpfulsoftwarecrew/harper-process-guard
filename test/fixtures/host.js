// A host that guards one process and stays up, so a test can kill it the way a container does; nothing
// in-process runs when a host is killed, which is why the reaper exists.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { guard } from '../../src/index.js';

const [pidDir, tag] = process.argv.slice(2);
const idle = fileURLToPath(new URL('./idle.js', import.meta.url));

const result = await guard({
	pidDir: pidDir ?? '',
	spawn,
	version: 1,
	processes: [{ name: 'guarded', binaryPath: process.execPath, args: [idle, tag ?? ''] }],
	reaper: { name: 'reaper', graceMs: 100, logFile: join(pidDir ?? '', 'reaper.log') },
});

process.stdout.write(`${JSON.stringify({ guarded: result.processes[0]?.pid, reaper: result.reaper })}\n`);
setInterval(() => {}, 1 << 30);
