import { applyFixPlan, planFixes } from '../fixPlan.mjs';

describe('planFixes', () => {
	it('merges non-overlapping fixes from different rules', () => {
		const { edits, conflicts } = planFixes([
			{ ruleName: 'rule-b', range: [10, 14], text: '1rem' },
			{ ruleName: 'rule-a', range: [2, 5], text: '.5' },
		]);

		expect(conflicts).toEqual([]);
		expect(edits).toEqual([
			{ ruleName: 'rule-a', range: [2, 5], text: '.5' },
			{ ruleName: 'rule-b', range: [10, 14], text: '1rem' },
		]);
	});

	it('rejects overlapping fixes from different rules and reports both rules', () => {
		const alpha = { ruleName: 'rule-alpha', range: [2, 5], text: '.5' };
		const gamma = { ruleName: 'rule-gamma', range: [4, 8], text: '0.50' };

		const { edits, conflicts } = planFixes([gamma, alpha]);

		expect(edits).toEqual([]);
		expect(conflicts).toEqual([{ first: alpha, second: gamma }]);
		expect(conflicts[0].first.ruleName).toBe('rule-alpha');
		expect(conflicts[0].second.ruleName).toBe('rule-gamma');
	});

	it('rejects nested fixes from different rules', () => {
		const outer = { ruleName: 'rule-outer', range: [0, 20], text: 'x' };
		const inner = { ruleName: 'rule-inner', range: [5, 8], text: 'y' };

		const { conflicts } = planFixes([outer, inner]);

		expect(conflicts).toHaveLength(1);
	});

	it('keeps the first of overlapping fixes from the same rule', () => {
		const { edits, conflicts } = planFixes([
			{ ruleName: 'rule-a', range: [2, 6], text: 'x' },
			{ ruleName: 'rule-a', range: [4, 8], text: 'y' },
		]);

		expect(conflicts).toEqual([]);
		expect(edits).toEqual([{ ruleName: 'rule-a', range: [2, 6], text: 'x' }]);
	});

	it('treats adjacent ranges as non-overlapping', () => {
		const { edits, conflicts } = planFixes([
			{ ruleName: 'rule-a', range: [0, 4], text: 'x' },
			{ ruleName: 'rule-b', range: [4, 8], text: 'y' },
		]);

		expect(conflicts).toEqual([]);
		expect(edits).toHaveLength(2);
	});
});

describe('applyFixPlan', () => {
	it('applies non-overlapping fixes together', () => {
		const css = 'a { foo: 0.5; bar: 10px; }';
		const {
			css: fixed,
			applied,
			conflicts,
		} = applyFixPlan(css, [
			{ ruleName: 'rule-a', range: [9, 12], text: '.5' },
			{ ruleName: 'rule-b', range: [19, 23], text: '1rem' },
		]);

		expect(applied).toBe(true);
		expect(conflicts).toEqual([]);
		expect(fixed).toBe('a { foo: .5; bar: 1rem; }');
	});

	it('returns the original source unchanged when fixes overlap', () => {
		const css = 'a { foo: 0.5; }';
		const {
			css: fixed,
			applied,
			conflicts,
		} = applyFixPlan(css, [
			{ ruleName: 'rule-a', range: [9, 12], text: '.5' },
			{ ruleName: 'rule-b', range: [10, 12], text: '0.50' },
		]);

		expect(applied).toBe(false);
		expect(fixed).toBe(css);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].first.ruleName).toBe('rule-a');
		expect(conflicts[0].second.ruleName).toBe('rule-b');
	});
});
