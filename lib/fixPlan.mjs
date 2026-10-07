import { readFile, writeFile } from 'node:fs/promises';

/**
 * @typedef {[number, number]} FixRange
 *   Offsets into the original source text: `[start, end)`
 *   (start inclusive, end exclusive).
 */

/**
 * @typedef {object} FixEdit
 *   A single planned fix: the rule name merged with the range
 *   in the original source text and the replacement text.
 * @property {string} ruleName Name of the rule that produced this edit.
 * @property {FixRange} range Range in the original source text to replace.
 * @property {string} text Replacement text.
 */

/**
 * @typedef {object} FixConflict
 *   A pair of edits whose original-source ranges overlap.
 * @property {[string, string]} rules Names of the two rules whose edits overlap.
 * @property {FixRange} range The overlapping range in the original source text.
 */

/**
 * @typedef {object} FixPlan
 * @property {boolean} applicable Whether every edit can be applied together.
 * @property {FixEdit[]} edits Edits sorted by range. Empty when the plan is not applicable.
 * @property {FixConflict[]} conflicts Overlapping edit pairs, if any.
 */

/**
 * @typedef {object} FixPlanResult
 * @property {boolean} applied Whether the edits were applied.
 * @property {string} output The fixed source, or the untouched original source
 *   when the plan was rejected.
 * @property {FixConflict[]} conflicts Overlapping edit pairs, if any.
 */

/**
 * Check a set of single-file fix edits for overlapping ranges.
 *
 * Edits are merged into one plan and sorted by their range in the original
 * source. When two edits overlap, the plan is rejected and both rules are
 * reported in the returned conflicts.
 *
 * @param {FixEdit[]} edits
 * @returns {FixPlan}
 */
export function planFixes(edits) {
	assertFixEdits(edits);

	const sorted = [...edits].sort(
		(a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1],
	);

	/** @type {FixConflict[]} */
	const conflicts = [];

	/** @type {FixEdit | undefined} */
	let occupant;

	for (const edit of sorted) {
		if (occupant && edit.range[0] < occupant.range[1]) {
			conflicts.push({
				rules: [occupant.ruleName, edit.ruleName],
				range: [edit.range[0], Math.min(edit.range[1], occupant.range[1])],
			});
		}

		if (!occupant || edit.range[1] > occupant.range[1]) {
			occupant = edit;
		}
	}

	const applicable = conflicts.length === 0;

	return { applicable, edits: applicable ? sorted : [], conflicts };
}

/**
 * Apply a fix plan to the given source text.
 *
 * Non-overlapping edits are applied together. When any two edits overlap,
 * nothing is applied and the original source is returned unchanged.
 *
 * @param {string} source
 * @param {FixEdit[]} edits
 * @returns {FixPlanResult}
 */
export function applyFixPlan(source, edits) {
	if (typeof source !== 'string') {
		throw new TypeError('`source` must be a string');
	}

	const plan = planFixes(edits);

	if (!plan.applicable) {
		return { applied: false, output: source, conflicts: plan.conflicts };
	}

	for (const edit of plan.edits) {
		if (edit.range[1] > source.length) {
			throw new RangeError(
				`Fix range [${edit.range[0]}, ${edit.range[1]}) of "${edit.ruleName}" is out of bounds`,
			);
		}
	}

	let output = '';
	let cursor = 0;

	for (const edit of plan.edits) {
		const [start, end] = edit.range;

		output += source.slice(cursor, start);
		output += edit.text;
		cursor = end;
	}

	output += source.slice(cursor);

	return { applied: true, output, conflicts: [] };
}

/**
 * Apply a fix plan to a single file.
 *
 * The file is only written when every edit is applicable; when the plan is
 * rejected the file on disk is left untouched.
 *
 * @param {string} filePath
 * @param {FixEdit[]} edits
 * @returns {Promise<FixPlanResult>}
 */
export async function applyFixPlanToFile(filePath, edits) {
	const source = await readFile(filePath, 'utf8');
	const result = applyFixPlan(source, edits);

	if (result.applied && result.output !== source) {
		await writeFile(filePath, result.output, 'utf8');
	}

	return result;
}

/**
 * Describe conflicts as human-readable messages reporting both rules.
 *
 * @param {FixConflict[]} conflicts
 * @returns {string[]}
 */
export function describeFixConflicts(conflicts) {
	return conflicts.map(
		({ rules: [first, second], range: [start, end] }) =>
			`Fix conflict between "${first}" and "${second}": edits overlap in the original source range [${start}, ${end}). Automatic fixes were not applied.`,
	);
}

/**
 * @param {unknown} edits
 * @returns {asserts edits is FixEdit[]}
 */
function assertFixEdits(edits) {
	if (!Array.isArray(edits)) {
		throw new TypeError('`edits` must be an array of fix edits');
	}

	for (const edit of edits) {
		if (edit === null || typeof edit !== 'object') {
			throw new TypeError('Each fix edit must be an object');
		}

		const { ruleName, range, text } = /** @type {FixEdit} */ (edit);

		if (typeof ruleName !== 'string' || ruleName === '') {
			throw new TypeError('Each fix edit must have a non-empty string `ruleName`');
		}

		if (
			!Array.isArray(range) ||
			range.length !== 2 ||
			!Number.isInteger(range[0]) ||
			!Number.isInteger(range[1]) ||
			range[0] < 0 ||
			range[1] < range[0]
		) {
			throw new TypeError(
				`Fix range of "${ruleName}" must be a [start, end] pair of integers with 0 <= start <= end`,
			);
		}

		if (typeof text !== 'string') {
			throw new TypeError(`Fix text of "${ruleName}" must be a string`);
		}
	}
}
