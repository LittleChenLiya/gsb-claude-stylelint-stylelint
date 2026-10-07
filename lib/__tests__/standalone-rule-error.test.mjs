import { rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import fCache from 'file-entry-cache';

import replaceBackslashes from '../testUtils/replaceBackslashes.mjs';
import safeChdir from '../testUtils/safeChdir.mjs';
import standalone from '../standalone.mjs';

const dirname = import.meta.dirname;

describe('standalone rule errors', () => {
	const cwd = path.join(dirname, 'tmp', 'standalone-rule-error');

	safeChdir(cwd);

	const fileA = path.join(cwd, 'a.css');
	const fileB = path.join(cwd, 'b.css');
	const cacheFilePath = path.join(cwd, '.stylelintcache');

	const boom = new Error('boom from spy rule');

	/** @type {Array<string | undefined>} */
	let spyCalls;

	let armed = true;

	// A spy rule that records the files it runs on and throws on the second file
	const spyPlugin = {
		ruleName: 'spy/throw-on-second-file',
		rule: () => (root) => {
			const file = root.source?.input.file;

			spyCalls.push(file);

			if (armed && file === fileB) throw boom;
		},
	};

	const config = { plugins: [spyPlugin], rules: { 'spy/throw-on-second-file': true } };

	const lintFiles = (options = {}) =>
		standalone({
			files: [replaceBackslashes(fileA), replaceBackslashes(fileB)],
			config,
			...options,
		});

	beforeEach(async () => {
		spyCalls = [];
		armed = true;

		await writeFile(fileA, 'a { color: red; }\n');
		await writeFile(fileB, 'b { color: blue; }\n');
	});

	afterEach(async () => {
		await rm(fileA, { force: true });
		await rm(fileB, { force: true });
		await rm(cacheFilePath, { force: true });
	});

	it('rejects with the rule name, the failing file and the original error as cause', async () => {
		const error = await lintFiles().then(
			() => {
				throw new Error('expected the lint run to reject');
			},
			(err) => err,
		);

		// the rule error is not turned into a lint problem: the run rejects
		expect(error).toBeInstanceOf(Error);
		expect(error.name).not.toBe('CssSyntaxError');

		// the error is attributed to the second file, not the first one
		expect(error.message).toContain('spy/throw-on-second-file');
		expect(error.message).toContain(fileB);
		expect(error.message).not.toContain(fileA);

		// the original error is preserved as `cause`
		expect(error.cause).toBe(boom);
	});

	it('annotates errors thrown while initializing a rule', async () => {
		const throwingPlugin = {
			ruleName: 'spy/throw-on-init',
			rule: () => {
				throw boom;
			},
		};

		const error = await standalone({
			code: 'a {}',
			config: { plugins: [throwingPlugin], rules: { 'spy/throw-on-init': true } },
		}).then(
			() => {
				throw new Error('expected the lint run to reject');
			},
			(err) => err,
		);

		expect(error.message).toContain('spy/throw-on-init');
		expect(error.message).toContain('boom from spy rule');
		expect(error.cause).toBe(boom);
	});

	it('annotates rule errors without a file when linting code', async () => {
		const alwaysThrowingPlugin = {
			ruleName: 'spy/always-throws',
			rule: () => () => {
				throw boom;
			},
		};

		const error = await standalone({
			code: 'a {}',
			config: { plugins: [alwaysThrowingPlugin], rules: { 'spy/always-throws': true } },
		}).then(
			() => {
				throw new Error('expected the lint run to reject');
			},
			(err) => err,
		);

		expect(error.message).toBe('Error while running rule "spy/always-throws": boom from spy rule');
		expect(error.cause).toBe(boom);
	});

	it('does not cache the failed file as a success', async () => {
		// warm up the cache with a successful run
		armed = false;
		await lintFiles({ cache: true });

		expect(existsSync(cacheFilePath)).toBe(true);

		// change the second file so it is linted again, and make the rule throw on it
		await writeFile(fileB, 'b { color: blue; background: white; }\n');

		spyCalls = [];
		armed = true;

		await expect(lintFiles({ cache: true })).rejects.toThrow('spy/throw-on-second-file');
		expect(spyCalls).toContain(fileB);

		// the failed file must not hit the cached success entry
		const fileCache = fCache.createFromFile(cacheFilePath);

		expect(fileCache.getFileDescriptor(fileB).changed).toBe(true);

		// a later run lints the failed file again instead of serving a cached success
		spyCalls = [];

		await expect(lintFiles({ cache: true })).rejects.toThrow('spy/throw-on-second-file');
		expect(spyCalls).toContain(fileB);
	});
});
