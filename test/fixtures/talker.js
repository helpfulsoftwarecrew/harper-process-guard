// Writes 16 KiB to stdout and stderr every 20 ms, blocking while either pipe is full, and counts rounds in argv[2].
import fs from 'node:fs';

const chunk = Buffer.alloc(1 << 14, '.');
const progress = process.argv[2] ?? '';
let rounds = 0;
setInterval(() => {
	fs.writeSync(1, chunk);
	fs.writeSync(2, chunk);
	// Replaced whole, since a file rewritten in place reads empty to a reader that lands between truncate and write.
	fs.writeFileSync(`${progress}.tmp`, String((rounds += 1)));
	fs.renameSync(`${progress}.tmp`, progress);
}, 20);
