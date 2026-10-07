/**
 * A tiny spy rule for rule-error tests.
 *
 * Calls are recorded on `calls` so tests can assert which sources the rule
 * ran against. When the rule is applied to a source whose path contains
 * `failOn`, it throws `failure`, simulating a broken rule/plugin.
 */
/** @type {Array<{ file: string | undefined }>} */
export const calls = [];

export const failure = new Error('boom from spy rule');

function rule(/** @type {{ failOn?: string }} */ settings) {
	return async (/** @type {import('postcss').Root} */ root) => {
		const file = root.source?.input.file;

		calls.push({ file });

		if (file && settings.failOn && file.includes(settings.failOn)) {
			throw failure;
		}
	};
}

export default {
	ruleName: 'spy/throws-on-second-file',
	rule,
};
