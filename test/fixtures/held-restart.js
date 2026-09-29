// Preloaded into a keeper: once it has announced a restart, it reads the lock only after a joining thread has.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const fs = createRequire(import.meta.url)('node:fs');
const lock = process.env.GUARD_HELD_LOCK;
const marker = process.env.GUARD_HELD_MARKER ?? '';
const readFileSync = fs.readFileSync;
const restarting = () => {
	try {
		return JSON.parse(readFileSync(`${lock}.exit`, 'utf-8')).outcome === 'restarting';
	} catch {
		return false;
	}
};
if (process.argv.includes('--keep')) {
	fs.readFileSync = (/** @type {string} */ file, /** @type {unknown} */ options) => {
		const deadline = Date.now() + 10_000;
		while (file === lock && restarting() && !fs.existsSync(marker) && Date.now() < deadline)
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		return readFileSync(file, options);
	};
	syncBuiltinESMExports();
}
