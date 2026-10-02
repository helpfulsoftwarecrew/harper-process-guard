// @ts-check
// publish.yml is read off disk and its steps run under bash against a stub npm, since nothing else exercises
// them before a tag is pushed and a fault there surfaces only after a release.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { REPO_ROOT, skipOnWindows } from '../support/harness.js';

const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'publish.yml');
const text = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
/** @typedef {{ name?: string, uses?: string, run?: string, env?: Record<string, string>, with?: Record<string, string> }} Step */
/** @type {{ jobs: { publish: { permissions?: Record<string, string>, steps: Step[] } } }} */
const workflow = parse(text);
const steps = workflow.jobs.publish.steps;

/** @param {string} name @returns {Step} */
function step(name) {
	const found = steps.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`publish.yml has no step named "${name}"`);
	return found;
}

const BASH_ONLY = 'the steps are bash scripts for an ubuntu runner, and a Windows test host has no bash to run them';

// Answers the four npm calls the steps make, from the environment, and records each publish it is asked for.
const STUB_NPM = `#!/usr/bin/env bash
case "$1 $3" in
  '--version '*) echo "\${STUB_NPM_VERSION:-11.6.2}" ;;
  'view dist-tags.latest')
    case "$STUB_LATEST" in
      E404 | ECONNRESET) echo "npm error code $STUB_LATEST" >&2; exit 1 ;;
      *) echo "$STUB_LATEST" ;;
    esac ;;
  'view version')
    if [ -n "$STUB_PUBLISHED" ]; then echo "$STUB_PUBLISHED"; else echo 'npm error code E404' >&2; exit 1; fi ;;
  'publish '*) echo "$*" >>"$STUB_LOG" ;;
  *) echo "stub npm was not expecting: $*" >&2; exit 2 ;;
esac
`;

/**
 * Runs one step's script the way a runner does (`bash -e`), in a checkout holding only package.json.
 *
 * @param {string} name @param {string} version @param {Record<string, string>} stub
 * @returns {{ status: number | null, stdout: string, output: string, published: string[] }}
 */
function runStep(name, version, stub) {
	const { run = '', env = {} } = step(name);
	// No withTempDir: a step starts nothing that outlives it, and its process-table sweep costs seconds per call.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-step-'));
	try {
		const bin = path.join(dir, 'bin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'npm'), STUB_NPM, { mode: 0o755 });
		const work = path.join(dir, 'work');
		fs.mkdirSync(work);
		fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: '@scope/pkg', version }));
		const outputFile = path.join(dir, 'output');
		const log = path.join(dir, 'npm.log');
		fs.writeFileSync(outputFile, '');
		fs.writeFileSync(log, '');
		const result = spawnSync('bash', ['-e', '-c', run], {
			cwd: work,
			encoding: 'utf-8',
			env: {
				...process.env,
				...env,
				...stub,
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
				GITHUB_OUTPUT: outputFile,
				RUNNER_TEMP: dir,
				STUB_LOG: log,
			},
		});
		return {
			status: result.status,
			stdout: result.stdout + result.stderr,
			output: fs.readFileSync(outputFile, 'utf-8'),
			published: fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean),
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('publishing authenticates through OIDC alone: no npm token is wired into the job', () => {
	assert.equal(workflow.jobs.publish.permissions?.['id-token'], 'write', 'the OIDC exchange needs id-token: write');
	assert.doesNotMatch(text, /secrets\.NPM_TOKEN/, 'a token secret would be preferred to, or stand in for, OIDC');
	for (const each of steps) {
		assert.equal(each.env?.NODE_AUTH_TOKEN, undefined, `"${each.name}" hands npm a token`);
	}
	const setup = steps.find((each) => each.uses?.startsWith('actions/setup-node@'));
	assert.ok(setup, 'publish.yml no longer sets up Node');
	// registry-url writes an .npmrc that reads NODE_AUTH_TOKEN, and setup-node exports a placeholder for it.
	assert.equal(setup.with?.['registry-url'], undefined);
	assert.equal(setup.with?.['always-auth'], undefined);
	assert.equal(step('Publish to npm').env?.NPM_CONFIG_PROVENANCE, 'true', 'provenance is no longer requested');
});

test('nothing writes a dist-tag after the publish, and no prerelease tag is left', () => {
	assert.doesNotMatch(text, /dist-tag (add|rm)/, 'OIDC covers npm publish only, so a dist-tag write fails the job');
	assert.doesNotMatch(text, /\bnext\b/, 'the next dist-tag is retired');
	assert.equal(steps.at(-1)?.name, 'Publish to npm', 'a step after the publish runs once the release is out');
});

test('a prerelease version is refused, and a stable one passes', (t) => {
	if (skipOnWindows(t, BASH_ONLY)) return;
	for (const version of ['1.1.0-rc.1', '2.0.0-0', '1.0.2-beta']) {
		const refused = runStep('Refuse a prerelease version', version, {});
		assert.equal(refused.status, 1, `${version} was not refused: ${refused.stdout}`);
		assert.match(refused.stdout, /^::error::Version .* is a prerelease/m);
	}
	const stable = runStep('Refuse a prerelease version', '1.0.2', {});
	assert.equal(stable.status, 0, stable.stdout);
});

test('an npm too old to publish through OIDC fails the job before the publish', (t) => {
	if (skipOnWindows(t, BASH_ONLY)) return;
	const old = runStep('Refuse an npm too old for trusted publishing', '1.0.2', { STUB_NPM_VERSION: '11.5.0' });
	assert.equal(old.status, 1, old.stdout);
	assert.match(old.stdout, /^::error::npm 11\.5\.0 cannot publish through OIDC/m);
	for (const have of ['11.5.1', '11.10.0', '12.0.0']) {
		const ok = runStep('Refuse an npm too old for trusted publishing', '1.0.2', { STUB_NPM_VERSION: have });
		assert.equal(ok.status, 0, `${have}: ${ok.stdout}`);
	}
});

test('the dist-tag is latest for a newer version or a new package, and release-<major>.<minor> for an older line', (t) => {
	if (skipOnWindows(t, BASH_ONLY)) return;
	/** @type {[version: string, latest: string, tag: string][]} */
	const cases = [
		['1.0.0', 'E404', 'latest'],
		['1.0.2', '1.0.1', 'latest'],
		['1.0.10', '1.0.9', 'latest'],
		['2.0.0', '1.9.12', 'latest'],
		['1.0.0', '1.0.0-rc.4', 'latest'],
		['1.0.1', '1.0.1', 'latest'],
		['1.0.9', '1.0.10', 'release-1.0'],
		['1.0.3', '2.1.0', 'release-1.0'],
		['2.0.5', '2.1.0', 'release-2.0'],
	];
	for (const [version, latest, tag] of cases) {
		const chosen = runStep('Choose the dist-tag', version, { STUB_LATEST: latest });
		assert.equal(chosen.status, 0, `${version} against latest ${latest}: ${chosen.stdout}`);
		assert.equal(chosen.output, `tag=${tag}\n`, `${version} against latest ${latest}`);
	}
});

test('a latest the registry fails to report fails the job rather than reading as a new package', (t) => {
	if (skipOnWindows(t, BASH_ONLY)) return;
	const failed = runStep('Choose the dist-tag', '1.0.3', { STUB_LATEST: 'ECONNRESET' });
	assert.equal(failed.status, 1, failed.stdout);
	assert.match(failed.stdout, /^::error::The latest dist-tag of @scope\/pkg could not be read/m);
	assert.equal(failed.output, '', 'a tag was chosen without knowing latest');
});

test('the publish goes out under the chosen tag, and a version already published is not sent again', (t) => {
	if (skipOnWindows(t, BASH_ONLY)) return;
	const sent = runStep('Publish to npm', '1.0.3', { DIST_TAG: 'release-1.0', STUB_PUBLISHED: '' });
	assert.equal(sent.status, 0, sent.stdout);
	assert.deepEqual(sent.published, ['publish --access public --tag release-1.0']);
	const again = runStep('Publish to npm', '1.0.3', { DIST_TAG: 'release-1.0', STUB_PUBLISHED: '1.0.3' });
	assert.equal(again.status, 0, again.stdout);
	assert.deepEqual(again.published, []);
});
