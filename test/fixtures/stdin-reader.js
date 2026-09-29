// Announces itself on stdout, then on end-of-file on stdin writes argv[2] and exits 0, as a process watching its parent does.
import fs from 'node:fs';

process.stdout.write('reading stdin\n');
process.stdin.on('end', () => {
	fs.writeFileSync(process.argv[2] ?? '', 'eof');
	process.exit(0);
});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
