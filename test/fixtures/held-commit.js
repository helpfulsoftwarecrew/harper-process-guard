// Preloaded into a keeper: its first rename onto one lock, which is its commit inside the gate, waits until a set time.
import { createRequire, syncBuiltinESMExports } from 'node:module';

if (process.argv.includes('--keep')) {
	const fs = createRequire(import.meta.url)('node:fs');
	const lock = process.env.GUARD_HELD_COMMIT;
	const until = Number(process.env.GUARD_HELD_COMMIT_UNTIL);
	const renameSync = fs.renameSync;
	let held = false;
	fs.renameSync = (/** @type {string} */ from, /** @type {string} */ to) => {
		if (!held && to === lock) {
			held = true;
			while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
		return renameSync(from, to);
	};
	syncBuiltinESMExports();
}
