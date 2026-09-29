// Preloaded into a keeper: taking one lock's gate fails with EPERM, so the keeper's release of that lock throws.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const fs = createRequire(import.meta.url)('node:fs');
const gate = `${process.env.GUARD_REFUSED_GATE}.claiming`;
const linkSync = fs.linkSync;
fs.linkSync = (/** @type {string} */ from, /** @type {string} */ to) => {
	if (to === gate) throw Object.assign(new Error(`EPERM: operation not permitted, link -> '${to}'`), { code: 'EPERM' });
	return linkSync(from, to);
};
syncBuiltinESMExports();
