// Preloaded into a keeper: its write of one lock's exit record waits first, so a thread sees the death before the record.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const fs = createRequire(import.meta.url)('node:fs');
const prefix = `${process.env.GUARD_SLOW_RECORD}.exit.`;
const holdMs = Number(process.env.GUARD_SLOW_RECORD_MS);
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = (/** @type {string} */ file, /** @type {unknown[]} */ ...rest) => {
	if (typeof file === 'string' && file.startsWith(prefix))
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
	return writeFileSync(file, ...rest);
};
syncBuiltinESMExports();
