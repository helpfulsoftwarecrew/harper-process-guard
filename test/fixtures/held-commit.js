// Preloaded into a keeper: its commit onto one lock takes the gate at one set time and renames at a later one.
import { createRequire, syncBuiltinESMExports } from 'node:module';

if (process.argv.includes('--keep')) {
	const fs = createRequire(import.meta.url)('node:fs');
	const lock = process.env.GUARD_HELD_COMMIT;
	const enter = Number(process.env.GUARD_HELD_COMMIT_ENTER ?? 0);
	const until = Number(process.env.GUARD_HELD_COMMIT_UNTIL);
	const pause = (/** @type {number} */ time) => {
		while (Date.now() < time) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	};
	const { renameSync, writeFileSync } = fs;
	let entered = false;
	let held = false;
	// Held before the gate's own file is written, since a gate's age is that file's: the gate is then no older than a
	// real commit's when its thread comes to it.
	fs.writeFileSync = (/** @type {any} */ file, /** @type {any[]} */ ...rest) => {
		if (!entered && typeof file === 'string' && file.startsWith(`${lock}.claiming.`)) {
			entered = true;
			pause(enter);
		}
		return writeFileSync(file, ...rest);
	};
	fs.renameSync = (/** @type {string} */ from, /** @type {string} */ to) => {
		if (!held && to === lock) {
			held = true;
			pause(until);
		}
		return renameSync(from, to);
	};
	syncBuiltinESMExports();
}
