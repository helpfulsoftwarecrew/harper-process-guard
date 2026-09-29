// Writes 16 KiB to stdout and stderr every 20 ms, blocking while either pipe is full, and counts rounds in argv[2].
import fs from 'node:fs';

const chunk = Buffer.alloc(1 << 14, '.');
let rounds = 0;
setInterval(() => {
	fs.writeSync(1, chunk);
	fs.writeSync(2, chunk);
	fs.writeFileSync(process.argv[2] ?? '', String((rounds += 1)));
}, 20);
