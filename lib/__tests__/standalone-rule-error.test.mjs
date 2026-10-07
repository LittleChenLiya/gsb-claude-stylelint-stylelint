import { rm } from 'node:fs/promises';

import path from 'node:path';

import fCache from 'file-entry-cache';

import { calls, failure } from './fixtures/rule-error/spy-rule.mjs';
import { RuleError } from '../utils/errors.mjs';

import replaceBackslashes from '../testUtils/replaceBackslashes.mjs';
import safeChdir from '../testUtils/safeChdir.mjs';
import standalone from '../standalone.mjs';

const dirname = import.meta.dirname;

const fixturesPath = path.join(dirname, 'fixtures', 'rule-error');
const firstFile = replaceBackslashes(path.join(fixturesPath, 'first.css'));
const secondFile = replaceBackslashes(path.join(fixturesPath, 'second.css'));
const bothFiles = replaceBackslashes(path.join(fixturesPath, '*.css'));

const config = () => ({
	plugins: [replaceBackslashes(path.join(fixturesPath, 'spy-rule.mjs'))],
	rules: {
		'spy/throws-on-second-file': { failOn: 'second.css' },
	},
});

// PostCSS keeps the `from` path on Windows with backslashes, so compare
// against both separator styles.
const nativePath = (file) => file.replaceAll('/', path.sep);

const containsPath = (message, file) =>
	[file, nativePath(file)].some((filePath) => message.includes(filePath));

beforeEach(() => {
	calls.length = 0;
});

describe('rule runtime errors', () => {
	it('annotates the error with the rule name, the current source file and the cause', async () => {
		let error;

		try {
			await standalone({ files: secondFile, config: config() });
		} catch (e) {
			error = e;
		}

		expect(error).toBeInstanceOf(RuleError);
		expect(error?.name).toBe('RuleError');
		expect(error?.message).toContain('spy/throws-on-second-file');
		expect(containsPath(error?.message ?? '', secondFile)).toBe(true);
		expect(error?.cause).toBe(failure);
	});

	it('is not reported as an ordinary lint violation when linting code', async () => {
		// A code input whose virtual filename matches the spy's fail condition
		await expect(
			standalone({ code: 'b {}', codeFilename: secondFile, config: config() }),
		).rejects.toMatchObject({ name: 'RuleError', cause: failure });
	});

	it('attributes a multi-file error to the failing file, not to the previous one', async () => {
		let error;

		try {
			await standalone({ files: bothFiles, config: config() });
		} catch (e) {
			error = e;
		}

		expect(error).toBeInstanceOf(RuleError);
		expect(containsPath(error?.message ?? '', secondFile)).toBe(true);
		expect(containsPath(error?.message ?? '', firstFile)).toBe(false);
		expect(error?.cause).toBe(failure);

		// The error was raised by the rule applied to the failing (second) file
		expect(calls.map((call) => call.file)).toContain(nativePath(secondFile));
	});

	it('keeps the original abort behavior', async () => {
		const controller = new AbortController();

		controller.abort(new Error('mid-run'));

		await expect(
			standalone({ files: secondFile, config: config(), abortSignal: controller.signal }),
		).rejects.toThrow('mid-run');
	});
});

describe('rule runtime errors with cache', () => {
	const cwd = path.join(dirname, 'tmp', 'standalone-rule-error-cache');
	const cacheFilePath = replaceBackslashes(path.join(cwd, '.stylelintcache'));

	// file-entry-cache stores native (backslashed on Windows) paths as keys
	const firstFileNative = path.join(fixturesPath, 'first.css');
	const secondFileNative = path.join(fixturesPath, 'second.css');

	safeChdir(cwd);

	beforeEach(async () => {
		// Warm the success cache with a file that the spy does not fail on
		await standalone({
			files: firstFile,
			config: config(),
			cache: true,
			cacheLocation: cacheFilePath,
		});
	});

	afterEach(async () => {
		await rm(cacheFilePath, { force: true });
	});

	it('does not save the failed file into the success cache', async () => {
		// The run over both files fails on the second file
		await expect(
			standalone({
				files: bothFiles,
				config: config(),
				cache: true,
				cacheLocation: cacheFilePath,
			}),
		).rejects.toBeInstanceOf(RuleError);

		const { cache } = fCache.createFromFile(cacheFilePath);

		// The previously successful file is cached; the failed file is not
		expect(cache.getKey(firstFileNative)).toBeTruthy();
		expect(cache.getKey(secondFileNative)).toBeUndefined();

		// A second run still lints the failed file instead of skipping it via cache
		calls.length = 0;

		await expect(
			standalone({
				files: bothFiles,
				config: config(),
				cache: true,
				cacheLocation: cacheFilePath,
			}),
		).rejects.toBeInstanceOf(RuleError);

		expect(calls).toContainEqual({ file: nativePath(secondFile) });
		expect(calls).not.toContainEqual({ file: nativePath(firstFile) });
	});
});
