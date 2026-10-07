// NOTE: This test uses the `node:test` module so it can run without the
// Jest setup. Run it via `npm run test-node` or `node --test <this file>`.

import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
	applyFixPlan,
	applyFixPlanToFile,
	describeFixConflicts,
	planFixes,
} from '../fixPlan.mjs';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
const fixturePath = path.join(fixturesDir, 'fix-plan.css');

// Three example rules. Each one merges its name, the range in the original
// source and the replacement text into a fix edit, and always reports a
// plain warning as well.

const HEX_LENGTH_RULE = 'example/hex-length';
const ZERO_UNIT_RULE = 'example/zero-unit';
const COLOR_KEYWORD_RULE = 'example/color-keyword';

/**
 * Example rule 1: shortens a long hex color. Its edit range covers only the
 * hex token, so it does not overlap with the zero-unit rule.
 */
function hexLengthRule(source) {
	const token = '#ffffff';
	const start = source.indexOf(token);

	if (start === -1) return { warnings: [], edits: [] };

	return {
		warnings: [`Expected "${token}" to be "#fff" (${HEX_LENGTH_RULE})`],
		edits: [{ ruleName: HEX_LENGTH_RULE, range: [start, start + token.length], text: '#fff' }],
	};
}

/**
 * Example rule 2: removes the unit from a zero length. Its edit range is
 * disjoint from the hex token.
 */
function zeroUnitRule(source) {
	const token = '0px';
	const start = source.indexOf(token);

	if (start === -1) return { warnings: [], edits: [] };

	return {
		warnings: [`Unexpected unit on zero (${ZERO_UNIT_RULE})`],
		edits: [{ ruleName: ZERO_UNIT_RULE, range: [start, start + token.length], text: '0' }],
	};
}

/**
 * Example rule 3: replaces a whole declaration with a color keyword. Its
 * edit range covers the hex token too, so it overlaps with example rule 1.
 */
function colorKeywordRule(source) {
	const token = 'color: #ffffff';
	const start = source.indexOf(token);

	if (start === -1) return { warnings: [], edits: [] };

	return {
		warnings: [`Expected "${token}" to be "color: white" (${COLOR_KEYWORD_RULE})`],
		edits: [
			{ ruleName: COLOR_KEYWORD_RULE, range: [start, start + token.length], text: 'color: white' },
		],
	};
}

function runRules(source, rules) {
	const warnings = [];
	const edits = [];

	for (const rule of rules) {
		const result = rule(source);

		warnings.push(...result.warnings);
		edits.push(...result.edits);
	}

	return { warnings, edits };
}

describe('planFixes', () => {
	it('sorts disjoint edits and accepts adjacent ranges', () => {
		const plan = planFixes([
			{ ruleName: 'b', range: [4, 6], text: 'y' },
			{ ruleName: 'a', range: [0, 2], text: 'x' },
			{ ruleName: 'c', range: [2, 4], text: 'z' },
		]);

		assert.equal(plan.applicable, true);
		assert.deepEqual(plan.conflicts, []);
		assert.deepEqual(
			plan.edits.map((edit) => edit.ruleName),
			['a', 'c', 'b'],
		);
	});

	it('rejects overlapping ranges and reports both rules', () => {
		const plan = planFixes([
			{ ruleName: 'a', range: [0, 5], text: 'x' },
			{ ruleName: 'b', range: [3, 8], text: 'y' },
		]);

		assert.equal(plan.applicable, false);
		assert.deepEqual(plan.edits, []);
		assert.equal(plan.conflicts.length, 1);
		assert.deepEqual(plan.conflicts[0].rules, ['a', 'b']);
		assert.deepEqual(plan.conflicts[0].range, [3, 5]);
	});
});

describe('applyFixPlan', () => {
	it('applies two non-overlapping fixes together', async () => {
		const source = await readFile(fixturePath, 'utf8');
		const { warnings, edits } = runRules(source, [hexLengthRule, zeroUnitRule]);

		const result = applyFixPlan(source, edits);

		assert.equal(result.applied, true);
		assert.deepEqual(result.conflicts, []);
		assert.equal(result.output, 'a {\n\tcolor: #fff;\n\tmargin: 0;\n}\n');

		// the plain warnings of both rules are still reported
		assert.equal(warnings.length, 2);
		assert.ok(warnings.some((warning) => warning.includes(HEX_LENGTH_RULE)));
		assert.ok(warnings.some((warning) => warning.includes(ZERO_UNIT_RULE)));
	});

	it('rejects overlapping fixes and leaves the original source unchanged', async () => {
		const source = await readFile(fixturePath, 'utf8');
		const { warnings, edits } = runRules(source, [hexLengthRule, colorKeywordRule]);

		const result = applyFixPlan(source, edits);

		assert.equal(result.applied, false);
		assert.equal(result.output, source);
		assert.equal(result.conflicts.length, 1);
		assert.deepEqual(result.conflicts[0].rules, [COLOR_KEYWORD_RULE, HEX_LENGTH_RULE]);

		const [message] = describeFixConflicts(result.conflicts);

		assert.ok(message.includes(`"${HEX_LENGTH_RULE}"`));
		assert.ok(message.includes(`"${COLOR_KEYWORD_RULE}"`));

		// the plain warnings of both rules are still reported
		assert.equal(warnings.length, 2);
		assert.ok(warnings.some((warning) => warning.includes(HEX_LENGTH_RULE)));
		assert.ok(warnings.some((warning) => warning.includes(COLOR_KEYWORD_RULE)));
	});

	it('keeps ordinary warnings when there is nothing to fix', async () => {
		const source = await readFile(fixturePath, 'utf8');
		const { warnings, edits } = runRules(source, [hexLengthRule]);

		const result = applyFixPlan(source, edits);

		assert.equal(result.applied, true);
		assert.equal(result.output, 'a {\n\tcolor: #fff;\n\tmargin: 0px;\n}\n');
		assert.deepEqual(warnings, [`Expected "#ffffff" to be "#fff" (${HEX_LENGTH_RULE})`]);
	});
});

describe('applyFixPlanToFile', () => {
	it('writes non-overlapping fixes to the file', async (t) => {
		const dir = await mkdtemp(path.join(fixturesDir, '.fix-plan-'));

		t.after(() => rm(dir, { recursive: true, force: true }));

		const file = path.join(dir, 'fix-plan.css');

		await copyFile(fixturePath, file);

		const source = await readFile(file, 'utf8');
		const { edits } = runRules(source, [hexLengthRule, zeroUnitRule]);

		const result = await applyFixPlanToFile(file, edits);

		assert.equal(result.applied, true);
		assert.equal(await readFile(file, 'utf8'), 'a {\n\tcolor: #fff;\n\tmargin: 0;\n}\n');
	});

	it('leaves the file untouched when fixes overlap', async (t) => {
		const dir = await mkdtemp(path.join(fixturesDir, '.fix-plan-'));

		t.after(() => rm(dir, { recursive: true, force: true }));

		const file = path.join(dir, 'fix-plan.css');

		await copyFile(fixturePath, file);

		const source = await readFile(file, 'utf8');
		const { warnings, edits } = runRules(source, [hexLengthRule, colorKeywordRule]);

		const result = await applyFixPlanToFile(file, edits);

		assert.equal(result.applied, false);
		assert.equal(result.conflicts.length, 1);

		// the original file is unchanged and the warnings are still reported
		assert.equal(await readFile(file, 'utf8'), source);
		assert.equal(warnings.length, 2);
	});
});
