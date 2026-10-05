import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EXIT_CODE_INVALID_CONFIG } from '../constants.mjs';
import { clearModuleCache } from '../utils/cachedImport.mjs';
import replaceBackslashes from '../testUtils/replaceBackslashes.mjs';
import reportConfig from '../reportConfig.mjs';
import standalone from '../standalone.mjs';

const fixturesDir = fileURLToPath(new URL('./fixtures/config-report', import.meta.url));

// Inputs use POSIX-style separators (Windows paths would look like globs),
// while resolved outputs are compared as native paths.
const fixturesPath = (...elems) => replaceBackslashes(path.join(fixturesDir, ...elems));
const fixturesNative = (...elems) => path.join(fixturesDir, ...elems);

describe('config resolution report', () => {
	it('attributes a disabled rule to the child config that disabled it', async () => {
		const report = await reportConfig({
			files: [fixturesPath('style.css')],
			configFile: fixturesPath('root.json'),
		});

		const rule = report.rules['block-no-empty'];

		// the parent config enables the rule, the child config disables it
		expect(rule.status).toBe('disabled');
		expect(rule.value).toBeNull();
		expect(rule.source).toEqual({ type: 'config', filepath: fixturesNative('middle.json') });

		// the history follows the actual load order
		expect(rule.history).toEqual([
			{ value: null, source: { type: 'config', filepath: fixturesNative('middle.json') } },
			{ value: true, source: { type: 'config', filepath: fixturesNative('base.json') } },
		]);

		// a rule that is missing from every config is absent, not "disabled"
		expect(report.rules).not.toHaveProperty('alpha-value-notation');
	});

	it('records the load order and the extends edges of a three-config chain', async () => {
		const report = await reportConfig({
			files: [fixturesPath('style.css')],
			configFile: fixturesPath('root.json'),
		});

		expect(report.configFile).toBe(fixturesNative('root.json'));
		expect(report.loadOrder).toEqual([
			{ filepath: fixturesNative('root.json'), via: 'configFile option' },
			{ filepath: fixturesNative('middle.json'), via: 'extends' },
			{ filepath: fixturesNative('base.json'), via: 'extends' },
		]);
		expect(report.extends).toEqual([
			{
				from: fixturesNative('root.json'),
				to: fixturesNative('middle.json'),
				specifier: './middle.json',
			},
			{
				from: fixturesNative('middle.json'),
				to: fixturesNative('base.json'),
				specifier: './base.json',
			},
		]);

		expect(report.rules['color-no-invalid-hex'].source).toEqual({
			type: 'config',
			filepath: fixturesNative('root.json'),
		});
	});

	it('attributes a whole options array to a single source', async () => {
		const report = await reportConfig({
			files: [fixturesPath('style.css')],
			configFile: fixturesPath('root.json'),
		});

		const rule = report.rules['color-named'];

		expect(rule.status).toBe('enabled');
		expect(rule.value).toEqual(['never', { severity: 'warning' }]);
		expect(rule.source).toEqual({ type: 'config', filepath: fixturesNative('base.json') });
	});

	it('shows when a file override takes effect', async () => {
		const scssReport = await reportConfig({
			files: [fixturesPath('style.scss')],
			configFile: fixturesPath('root.json'),
		});

		expect(scssReport.overrides).toEqual([
			{ index: 0, files: ['*.scss'], matched: true, configFile: fixturesNative('root.json') },
		]);
		expect(scssReport.rules['color-named'].value).toBe('always');
		expect(scssReport.rules['color-named'].source).toEqual({
			type: 'override',
			filepath: fixturesNative('root.json'),
			index: 0,
			files: ['*.scss'],
		});

		const cssReport = await reportConfig({
			files: [fixturesPath('style.css')],
			configFile: fixturesPath('root.json'),
		});

		expect(cssReport.overrides).toEqual([
			{ index: 0, files: ['*.scss'], matched: false, configFile: fixturesNative('root.json') },
		]);
		expect(cssReport.rules['color-named'].source).toEqual({
			type: 'config',
			filepath: fixturesNative('base.json'),
		});
	});

	it('rejects circular extends with the chain', async () => {
		const promise = reportConfig({
			files: [fixturesPath('style.css')],
			configFile: fixturesPath('circular-a.json'),
		});

		await expect(promise).rejects.toThrow(
			/^Circular configuration extends detected: .+circular-a\.json -> .+circular-b\.json -> .+circular-a\.json$/,
		);
		await expect(promise).rejects.toHaveProperty('code', EXIT_CODE_INVALID_CONFIG);
	});

	it('rejects circular extends when linting, too', async () => {
		await expect(
			standalone({ code: 'a {}', configFile: fixturesPath('circular-a.json') }),
		).rejects.toThrow('Circular configuration extends detected');
	});

	it('does not execute plugins an extra time and keeps unknown rule diagnostics', async () => {
		clearModuleCache();
		globalThis.__configReportPluginLoadCount = 0;

		const report = await reportConfig({
			files: [fixturesPath('style.css')],
			configFile: fixturesPath('config-with-plugin.json'),
		});

		// the plugin module was evaluated exactly once for the report
		expect(globalThis.__configReportPluginLoadCount).toBe(1);

		expect(report.plugins).toEqual([
			{
				name: fixturesNative('plugin-counter.mjs'),
				rules: ['plugin/counter'],
				declaredIn: [{ type: 'config', filepath: fixturesNative('config-with-plugin.json') }],
			},
		]);

		// unknown plugin rules are reported, known ones are not
		expect(report.unknownRules).toEqual(['plugin/unknown-thing']);
		expect(report.rules['plugin/counter'].status).toBe('enabled');

		// linting the same config still reports the unknown rule (default semantics)
		const { results } = await standalone({
			code: 'a {}',
			configFile: fixturesPath('config-with-plugin.json'),
		});

		expect(results[0].warnings.map((w) => w.text)).toContain('Unknown rule plugin/unknown-thing.');
	});

	it('throws with input code', async () => {
		await expect(reportConfig({ code: 'a {}' })).rejects.toThrow(
			'The --report-config option must be used with exactly one file path.',
		);
	});

	it('throws with globs', async () => {
		await expect(reportConfig({ files: ['./*.css'] })).rejects.toThrow(
			'The --report-config option does not support globs.',
		);
	});
});
