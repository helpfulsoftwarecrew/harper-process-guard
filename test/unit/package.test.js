// @ts-check
// The rules that stop being true silently unless a test reads them off the files that state them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { defaultRunners, REPO_ROOT } from '../support/harness.js';

const SRC = path.join(REPO_ROOT, 'src');
const sources = fs.readdirSync(SRC).filter((file) => file.endsWith('.js'));
/** @type {{ scripts: Record<string, string>, dependencies?: object, peerDependencies?: object, optionalDependencies?: object, exports: Record<string, string>, files: string[], os?: string[] }} */
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
/** @type {{ jobs?: { test?: { strategy?: { matrix?: { os?: unknown } }, steps?: { run?: string }[] } } }} */
const workflow = parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'), 'utf-8'));

test('what is written is what ships: no build step, and the entry points at the source', () => {
	assert.equal(manifest.exports['.'], './src/index.js');
	assert.ok(manifest.files.includes('src/'), 'the published tarball would carry no code at all');
	for (const name of ['build', 'prepare', 'prepublishOnly']) {
		assert.equal(manifest.scripts[name], undefined, `a "${name}" script would compile what is published`);
	}
	// `npm ci` runs `prepare`, so a build that crept in by a route the names above miss still lands here.
	assert.equal(fs.existsSync(path.join(REPO_ROOT, 'dist')), false);
});

/** A runner label against the process.platform it reports, so the two lists below compare as platforms. */
const PLATFORM_OF = new Map([
	['ubuntu-latest', 'linux'],
	['macos-latest', 'darwin'],
	['windows-latest', 'win32'],
]);

test('the platforms the manifest claims are exactly the platforms CI runs', () => {
	// `os` makes npm refuse the install anywhere else, so a platform claimed and never run is a promise nothing keeps.
	// The full list push and pull_request runs get; publish.yml narrowing it for a tag is publish-workflow.test.js's to check.
	const runners = defaultRunners(workflow.jobs?.test?.strategy?.matrix?.os);
	// A matrix that read as empty would let this agree with an `os` field saying anything at all.
	assert.ok(runners.length > 0, 'test.yml declares no os matrix for the test job');

	const tested = runners.map((label) => {
		const platform = PLATFORM_OF.get(label);
		if (!platform) throw new Error(`test.yml runs "${label}", which nothing here maps to a process.platform`);
		return platform;
	});
	assert.deepEqual(tested.toSorted(), (manifest.os ?? []).toSorted());
});

test('every command that gates a merge here is a command CI runs', () => {
	// A step dropped from test.yml is otherwise silent; matched on the command, so renaming a step costs nothing.
	const commands = (workflow.jobs?.test?.steps ?? []).map((step) => (step.run ?? '').trim());
	for (const gate of ['npm run format:check', 'npm run lint', 'npm run typecheck', 'npm test']) {
		assert.ok(commands.includes(gate), `test.yml has no step running \`${gate}\`, so CI no longer gates on it`);
	}
});

test('no runtime dependencies of any kind', () => {
	// Peer and optional land in a consumer's tree too, so absence has to hold across all three fields.
	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.peerDependencies, undefined);
	assert.equal(manifest.optionalDependencies, undefined);
});

test('no source file opts out of the typecheck', () => {
	assert.ok(sources.length > 0, 'no sources were found, so this asserted nothing');
	for (const file of sources) {
		// tsconfig sets checkJs, so only @ts-nocheck can silence a file, and typecheck still reports success.
		assert.doesNotMatch(fs.readFileSync(path.join(SRC, file), 'utf-8'), /@ts-nocheck/, `src/${file} is unchecked`);
	}
});

test('the source imports node: builtins and its own files, and nothing else', () => {
	for (const file of sources) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
		for (const [, specifier = ''] of text.matchAll(/^import [^']*'([^']+)'/gm)) {
			assert.ok(
				specifier.startsWith('node:') || specifier.startsWith('./'),
				`src/${file} imports "${specifier}", which is neither a builtin nor a sibling`
			);
		}
	}
});

test('the source knows nothing about any particular consumer', () => {
	// These are the names of the consumer most likely to leak into src/.
	for (const file of sources) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
		assert.doesNotMatch(text, /datadog|dd-trace|dd_/i, `src/${file} names a consumer`);
	}
});

test('the public surface is what a consumer calls, and nothing else', async () => {
	const surface = Object.keys(await import('../../src/index.js')).sort();
	// The whole public surface: a name is here only because a consumer needed it.
	assert.deepEqual(surface, [
		'REAPER_WATCH_MS',
		'argvOf',
		'claimSingleton',
		'claimStaleMs',
		'clearStaleHostPidFiles',
		'createHandleApplication',
		'currentReaper',
		'currentVerdict',
		'describeExit',
		'describeSpawnFailure',
		'fingerprint',
		'guard',
		'guardDescriptors',
		'heldProcess',
		'hostRoot',
		'identify',
		'keepReaperAlive',
		'neverStarted',
		'nodeProcess',
		'normaliseLog',
		'parseJson',
		'pollEndpoint',
		'pollUnixSocket',
		'readProcess',
		'resolvePort',
		'retakeVerdict',
		'selfProcess',
		'sharedMarks',
		'supervisesNatively',
		'supervisorFor',
		'tailFile',
		'takeVerdictAgainst',
		'unstarted',
		'untraceWith',
		'watchForNeverCalled',
		'writeFiles',
	]);
});
