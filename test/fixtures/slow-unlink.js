// Preloaded into a keeper: its unlink of one lock waits first, holding open the gap after its record is written.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const fs = createRequire(import.meta.url)('node:fs');
const target = process.env.GUARD_SLOW_UNLINK;
const holdMs = Number(process.env.GUARD_SLOW_UNLINK_MS);
const unlinkSync = fs.unlinkSync;
fs.unlinkSync = (/** @type {string} */ file) => {
	if (file === target) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
	return unlinkSync(file);
};
syncBuiltinESMExports();
