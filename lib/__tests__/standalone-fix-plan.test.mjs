import { copyFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { describe as suite } from '@jest/globals';

import replaceBackslashes from '../testUtils/replaceBackslashes.mjs';
import safeChdir from '../testUtils/safeChdir.mjs';
import standalone from '../standalone.mjs';
import uniqueId from '../testUtils/uniqueId.mjs';

const fixturesPath = (...elems) =>
	replaceBackslashes(path.join(fileURLToPath(new URL('./fixtures', import.meta.url)), ...elems));

const ORIGINAL_CSS = 'a {\n\tfoo: 0.5;\n\tbar: 10px;\n\tbaz: red;\n}\n';

suite('fix plan check for a single file', () => {
	safeChdir(new URL(`./tmp/standalone-fix-plan-${uniqueId()}`, import.meta.url));

	let tempFile;

	beforeEach(async () => {
		tempFile = replaceBackslashes(path.join(process.cwd(), 'fix-plan.css'));

		await copyFile(fixturesPath('fix-plan.css'), tempFile);
	});

	afterEach(async () => {
		await rm(tempFile, { force: true });
	});

	it('applies non-overlapping fixes from different rules together', async () => {
		const result = await standalone({
			files: [tempFile],
			config: {
				plugins: [
					fixturesPath('plugin-fix-plan-alpha.mjs'),
					fixturesPath('plugin-fix-plan-beta.mjs'),
				],
				rules: {
					'test/fix-plan-alpha': true,
					'test/fix-plan-beta': true,
				},
			},
			fix: true,
		});

		const fileContent = await readFile(tempFile, 'utf8');

		expect(fileContent).toBe('a {\n\tfoo: one;\n\tbar: 1rem;\n\tbaz: red;\n}\n');
		expect(result.results[0].autofixed).toBe(true);
		expect(result.results[0].warnings).toEqual([]);
	});

	it('rejects overlapping fixes, reports both rules and leaves the file unchanged', async () => {
		const result = await standalone({
			files: [tempFile],
			config: {
				plugins: [
					fixturesPath('plugin-fix-plan-alpha.mjs'),
					fixturesPath('plugin-fix-plan-gamma.mjs'),
				],
				rules: {
					'test/fix-plan-alpha': true,
					'test/fix-plan-gamma': true,
				},
			},
			fix: true,
		});

		const fileContent = await readFile(tempFile, 'utf8');

		// the original file is untouched
		expect(fileContent).toBe(ORIGINAL_CSS);
		expect(result.results[0].autofixed).toBeUndefined();

		const { warnings } = result.results[0];

		// the conflict is reported and names both rules
		const conflict = warnings.find(
			(w) => w.text.includes('test/fix-plan-alpha') && w.text.includes('test/fix-plan-gamma'),
		);

		expect(conflict).toBeDefined();
		expect(conflict.text).toContain('overlapping');

		// ordinary warnings still appear
		expect(
			warnings.some(
				(w) => w.rule === 'test/fix-plan-gamma' && w.text.includes('Unexpected named color "red"'),
			),
		).toBe(true);
	});

	it('reports ordinary warnings when fixes are disabled', async () => {
		const result = await standalone({
			files: [tempFile],
			config: {
				plugins: [
					fixturesPath('plugin-fix-plan-alpha.mjs'),
					fixturesPath('plugin-fix-plan-beta.mjs'),
					fixturesPath('plugin-fix-plan-gamma.mjs'),
				],
				rules: {
					'test/fix-plan-alpha': true,
					'test/fix-plan-beta': true,
					'test/fix-plan-gamma': true,
				},
			},
		});

		const fileContent = await readFile(tempFile, 'utf8');

		expect(fileContent).toBe(ORIGINAL_CSS);
		expect(result.results[0].autofixed).toBeUndefined();

		const rules = result.results[0].warnings.map((w) => w.rule);

		expect(rules).toContain('test/fix-plan-alpha');
		expect(rules).toContain('test/fix-plan-beta');
		expect(rules).toContain('test/fix-plan-gamma');
	});
});
