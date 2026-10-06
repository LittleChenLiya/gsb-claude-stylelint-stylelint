import rangesOverlap from './rangesOverlap.mjs';

/**
 * @typedef {object} PlannedFix
 * @property {string} ruleName - the rule that produced the fix
 * @property {[number, number]} range - offsets into the original source: [start, end)
 * @property {string} text - the replacement text for the range
 */

/**
 * @typedef {object} FixPlanConflict
 * @property {PlannedFix} first
 * @property {PlannedFix} second
 */

/**
 * Merge the planned fixes of a single file by their original ranges.
 *
 * Fixes with disjoint ranges are legal and can be applied together.
 * Overlapping fixes from different rules are rejected and both rules
 * are reported as a conflict. Overlapping fixes from the same rule keep
 * the first edit, mirroring how computed edit infos are de-duplicated.
 *
 * @param {PlannedFix[]} fixes
 * @returns {{ edits: PlannedFix[], conflicts: FixPlanConflict[] }}
 */
export function planFixes(fixes) {
	const sorted = [...fixes].sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);

	/** @type {PlannedFix[]} */
	const edits = [];
	/** @type {FixPlanConflict[]} */
	const conflicts = [];

	for (const fix of sorted) {
		const previous = edits[edits.length - 1];

		if (previous && rangesOverlap(previous.range, fix.range)) {
			if (previous.ruleName === fix.ruleName) continue;

			conflicts.push({ first: previous, second: fix });
			continue;
		}

		edits.push(fix);
	}

	if (conflicts.length > 0) {
		return { edits: [], conflicts };
	}

	return { edits, conflicts };
}

/**
 * Apply a fix plan to the original source of a single file.
 *
 * When any conflict is found, nothing is applied and the original
 * source is returned unchanged.
 *
 * @param {string} css - the original source
 * @param {PlannedFix[]} fixes
 * @returns {{ css: string, applied: boolean, conflicts: FixPlanConflict[] }}
 */
export function applyFixPlan(css, fixes) {
	const { edits, conflicts } = planFixes(fixes);

	if (conflicts.length > 0) {
		return { css, applied: false, conflicts };
	}

	let result = css;

	for (const { range, text } of [...edits].reverse()) {
		result = result.slice(0, range[0]) + text + result.slice(range[1]);
	}

	return { css: result, applied: true, conflicts };
}
