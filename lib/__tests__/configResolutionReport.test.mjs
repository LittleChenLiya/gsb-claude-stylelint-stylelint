import { fileURLToPath } from 'node:url';
import path from 'node:path';

import normalizeFilePath from '../utils/normalizeFilePath.mjs';
import resolveConfigReport from '../resolveConfigReport.mjs';
import standalone from '../standalone.mjs';

const fixturesPath = fileURLToPath(new URL('./fixtures/config-report', import.meta.url));
const fixture = (name) => normalizeFilePath(path.join(fixturesPath, name));

const BASE = fixture('base.mjs');
const MID = fixture('mid.mjs');
const ROOT = fixture('root.mjs');

it('records the extends chain in actual loading order', async () => {
	const report = await resolveConfigReport(fixture('a.css'), { configFile: ROOT });

	expect(report.root).toBe(ROOT);
	expect(report.files).toEqual([ROOT, MID, BASE]);
	expect(report.extends).toEqual([
		{ from: ROOT, to: MID },
		{ from: MID, to: BASE },
	]);
});

it('attributes a rule disabled by a child config to the child, not the parent', async () => {
	const report = await resolveConfigReport(fixture('a.css'), { configFile: ROOT });
	const provenance = report.rules.disabled['block-no-empty'];

	expect(provenance).toBeDefined();
	expect(report.rules.enabled['block-no-empty']).toBeUndefined();
	expect(provenance.source).toEqual({ file: MID });
	expect(provenance.value).toBeNull();
	expect(provenance.history).toEqual([
		{ source: { file: BASE }, value: true },
		{ source: { file: MID }, value: null },
	]);
});

it('attributes a whole options array to the same source', async () => {
	const report = await resolveConfigReport(fixture('a.css'), { configFile: ROOT });
	const provenance = report.rules.enabled['color-hex-length'];

	// the root config wins with a plain string …
	expect(provenance.source).toEqual({ file: ROOT });
	expect(provenance.value).toBe('short');

	// … and the losing options array stays attributed to the base config as one value
	expect(provenance.history[0]).toEqual({
		source: { file: BASE },
		value: ['long', { severity: 'warning' }],
	});
});

it('marks matching overrides as effective and attributes their rules to the override block', async () => {
	const report = await resolveConfigReport(fixture('a.scss'), { configFile: ROOT });

	expect(report.overrides).toEqual([
		{ file: ROOT, index: 0, files: ['*.scss'], matched: true },
		{ file: ROOT, index: 1, files: ['*.less'], matched: false },
	]);

	const added = report.rules.enabled['max-nesting-depth'];

	expect(added.source).toEqual({ file: ROOT, overrideIndex: 0 });
	expect(added.value).toEqual([2, { severity: 'warning' }]);

	const disabledByOverride = report.rules.disabled['declaration-no-important'];

	expect(disabledByOverride.source).toEqual({ file: ROOT, overrideIndex: 0 });
	expect(disabledByOverride.history).toEqual([
		{ source: { file: MID }, value: true },
		{ source: { file: ROOT, overrideIndex: 0 }, value: null },
	]);
});

it('marks overrides as not matched for files they do not cover', async () => {
	const report = await resolveConfigReport(fixture('a.css'), { configFile: ROOT });

	expect(report.overrides).toEqual([
		{ file: ROOT, index: 0, files: ['*.scss'], matched: false },
		{ file: ROOT, index: 1, files: ['*.less'], matched: false },
	]);
	expect(report.rules.enabled['max-nesting-depth']).toBeUndefined();
	expect(report.rules.enabled['declaration-no-important']).toBeDefined();
});

it('separates explicitly disabled rules from missing ones', async () => {
	const report = await resolveConfigReport(fixture('a.css'), { configFile: ROOT });

	// disabled: mentioned and set to null
	expect(report.rules.disabled['block-no-empty']).toBeDefined();

	// missing: never mentioned anywhere, so absent from both maps
	expect(report.rules.disabled['alpha-value-notation']).toBeUndefined();
	expect(report.rules.enabled['alpha-value-notation']).toBeUndefined();
});

it('rejects circular extends with the chain of config files', async () => {
	const promise = resolveConfigReport(fixture('a.css'), { configFile: fixture('cycle-a.mjs') });

	await expect(promise).rejects.toThrow(
		/Circular "extends" detected: .*cycle-a\.mjs -> .*cycle-b\.mjs -> .*cycle-a\.mjs/,
	);
});

it('rejects self-referencing extends', async () => {
	const promise = resolveConfigReport(fixture('a.css'), { configFile: fixture('cycle-self.mjs') });

	await expect(promise).rejects.toThrow(
		/Circular "extends" detected: .*cycle-self\.mjs -> .*cycle-self\.mjs/,
	);
});

it('rejects circular extends during linting too', async () => {
	const promise = standalone({
		code: 'a {}',
		configFile: fixture('cycle-a.mjs'),
	});

	await expect(promise).rejects.toThrow(/Circular "extends" detected:/);
});

it('does not execute plugins or read configs again to produce the report', async () => {
	globalThis.__configReportPluginEvals = 0;
	globalThis.__configReportPluginRuns = 0;

	const report = await resolveConfigReport(fixture('a.css'), {
		configFile: fixture('with-plugin.mjs'),
	});

	// the plugin module was evaluated exactly once (the normal loading pass)
	expect(globalThis.__configReportPluginEvals).toBe(1);
	// and its rule was never executed for the report
	expect(globalThis.__configReportPluginRuns).toBe(0);
	expect(report.plugins).toEqual([
		{ file: fixture('with-plugin.mjs'), plugin: './counting-plugin.mjs' },
	]);

	// linting afterwards still does not evaluate the plugin module again
	await standalone({ code: 'a {}', configFile: fixture('with-plugin.mjs') });
	expect(globalThis.__configReportPluginEvals).toBe(1);
	expect(globalThis.__configReportPluginRuns).toBe(1);
});

it('keeps diagnostics for unknown plugin rules', async () => {
	const { results } = await standalone({
		code: 'a {}',
		configFile: fixture('with-plugin.mjs'),
	});

	const unknownWarnings = results[0].warnings.filter((w) => w.rule === 'plugin/unknown-rule');

	expect(unknownWarnings).toHaveLength(1);
	expect(unknownWarnings[0].text).toBe('Unknown rule plugin/unknown-rule.');
});

it('returns undefined when no file path is given', async () => {
	await expect(resolveConfigReport()).resolves.toBeUndefined();
});
