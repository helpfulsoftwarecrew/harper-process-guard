// @ts-check
// The Harper boundary: an optional-everything logger, a plugin entry called once per thread or never, a root
// path the host will not name, and config files every thread writes at once.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { threadId } from 'node:worker_threads';

// -- What the host gives you ---------------------------------------------------------------------------------

/** @typedef {{ info(m: string): void, warn(m: string): void, error(m: string): void }} Log */

/**
 * All three methods whatever the host implements, each falling back to the next most severe thing it has and
 * to console.log. Bound, because Harper's logger reads `this`.
 *
 * @param {object} [host] Harper's compartment `logger`, or anything console-shaped.
 * @returns {Log}
 */
export function normaliseLog(host = console) {
	/** @type {Record<string, unknown>} */
	const methods = /** @type {any} */ (host);
	/** @type {(...names: string[]) => (message: string) => void} */
	const channel =
		(...names) =>
		(message) => {
			const write = names.map((name) => methods[name]).find((candidate) => typeof candidate === 'function');
			/** @type {(m: string) => void} */ (write ?? console.log).call(host, message);
		};
	return {
		info: channel('info', 'warn'),
		warn: channel('warn', 'info'),
		error: channel('error', 'warn'),
	};
}

// -- When it calls you, and when it does not ------------------------------------------------------------------

// 60s: handleApplication runs behind scope.ready, waitForDeployCompletion, and a per-plugin lock waiting
// Harper's plugin timeout plus 5s. A shorter window libels a slow node.
const START_DEADLINE_MS = 60_000;

/**
 * Watch for Harper never calling the plugin, which is what a component found by scanning componentsRoot
 * gets. Module evaluation is the only vantage point left, since nothing inside the plugin runs.
 *
 * @param {object} options
 * @param {Log} options.log
 * @param {string} options.label What this component calls itself in a log line, so this file names no consumer.
 * @param {string} options.configEntry The root-config line an operator has to add, already rendered.
 * @param {number} [options.deadlineMs]
 * @returns {{ seen(): void }} Call `seen` the moment the plugin is entered.
 */
export function watchForNeverCalled({ log, label, configEntry, deadlineMs = START_DEADLINE_MS }) {
	const timer = setTimeout(() => {
		log.error(
			`${label}: Harper has not called handleApplication ${deadlineMs / 1000}s after this ` +
				`module loaded, so no agent started and nothing on this node is supervising one. The likeliest ` +
				`cause is a component Harper loaded by scanning componentsRoot: it calls the plugin only for a ` +
				`component the root harper-config.yaml names, and the module it imports for a scanned directory ` +
				`is discarded.`
		);
		log.error(
			`${label}: add this to the node's harper-config.yaml (the file settings_path names in ` +
				`~/.harperdb/hdb_boot_properties.file), keyed by this directory's name, then restart Harper: ${configEntry}`
		);
	}, deadlineMs);
	// A diagnostic must not be the reason a worker thread stays up.
	timer.unref?.();
	return { seen: () => clearTimeout(timer) };
}

/**
 * The plugin entry, once per worker thread. A validation load starts nothing, or every `harper deploy`
 * re-enters the spawn path against a live node; a second call joins the first promise rather than starting.
 * Harper through 5.3 marks a deploy's validation load with `scope.isTransientValidation`; Harper's main
 * branch runs no validation load and sets no such flag (harperfast/harper 81ed6643c), so there the check never fires.
 *
 * @param {object} options
 * @param {(scope?: any) => Promise<object>} options.start
 * @param {{ seen(): void }} options.deadline
 * @param {{ get(): Promise<object> | undefined, set(p: Promise<object>): void }} options.slot Where the started promise lives, so the read path sees the same one.
 */
export function createHandleApplication({ start, deadline, slot }) {
	return function handleApplication(/** @type {any} */ scope) {
		// Being called at all disarms the deadline; a validation load counts, Harper reached the plugin.
		deadline.seen();
		// Kept for the released Harper lines that still run a validation load; a no-op from Harper main onward.
		if (scope?.isTransientValidation) return;
		if (!slot.get()) slot.set(start(scope));
	};
}

// -- What it will not tell you --------------------------------------------------------------------------------

/** Rejects `rootPath: null`, which Harper's own defaultConfig.yaml ships, and anything relative. */
const absolute = (/** @type {string | undefined | null} */ value) => (value && isAbsolute(value) ? value : null);

/** Harper's own chain: the boot properties name the settings file, and the settings file names the root. */
function readBootProperties() {
	try {
		const boot = readFileSync(join(homedir(), '.harperdb', 'hdb_boot_properties.file'), 'utf-8');
		// Java-style properties, and Harper indents every line after the first, so the whitespace class matters.
		const settingsPath = boot.match(/^[ \t]*settings_path[ \t]*=[ \t]*(.+?)[ \t]*$/m)?.[1];
		if (!settingsPath) return null;
		// rootPath is top level in harper-config.yaml: the one key readable off a single line without a parser.
		const rootPath = readFileSync(settingsPath, 'utf-8')
			.match(/^rootPath[ \t]*:[ \t]*(.+?)[ \t]*(?:#.*)?$/m)?.[1]
			?.replace(/^(['"])(.*)\1$/, '$2');
		return absolute(rootPath);
	} catch {
		return null;
	}
}

/**
 * Harper's root path, or null. ROOTPATH is the harper-pro image's own spelling and wins where it is usable.
 *
 * @param {Log} log @param {string} [label] How the consumer names itself in a warning.
 * @returns {string | null}
 */
export function hostRoot(log, label = 'process guard') {
	const spelled = process.env.ROOTPATH;
	if (spelled && !absolute(spelled))
		log.warn(
			`${label}: ROOTPATH="${spelled}" is not an absolute path, so it is ignored. A relative one resolves ` +
				`against each worker's own cwd, and two workers that disagree take different PID locks and each ` +
				`start their own processes.`
		);
	return absolute(spelled) ?? readBootProperties();
}

/**
 * A port from the environment or the fallback, never a number nobody wrote: parseInt reads "8126tcp" as
 * 8126, so the whole string is matched. `0` is kept, being how these processes spell "serve no endpoint".
 *
 * @param {string} name @param {number} fallback @param {Log} log @param {string} [label]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePort(name, fallback, log, label = 'process guard', env = process.env) {
	const raw = env[name];
	if (!raw) return fallback;
	const trimmed = raw.trim();
	if (trimmed === '0') return 0;
	const parsed = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (parsed >= 1 && parsed <= 65535) return parsed;
	log.warn(`${label}: ${name}="${raw}" is not a port in 1-65535. Using ${fallback}.`);
	return fallback;
}

/**
 * Write every file, replacing what was there. Temp-and-rename named per thread, because every worker writes
 * these at once and a reader must see one version or the other; one failure does not stop the rest.
 *
 * @param {Record<string, string>} files @param {Log} log @param {string} [label]
 */
export function writeFiles(files, log, label = 'process guard') {
	for (const [target, contents] of Object.entries(files)) {
		try {
			mkdirSync(dirname(target), { recursive: true });
			const temp = `${target}.${process.pid}.${threadId}.tmp`;
			writeFileSync(temp, contents, 'utf-8');
			renameSync(temp, target);
		} catch (error) {
			log.error(`${label}: could not write ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
