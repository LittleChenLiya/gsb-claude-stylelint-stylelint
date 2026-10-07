/** @import {ConfigResolutionReport, ConfigRuleProvenance, ConfigValueSource} from 'stylelint' */

/**
 * @typedef {Object} ConfigResolutionEvent
 * @property {'file' | 'extend' | 'rules' | 'override' | 'plugins'} type
 * @property {string} [file]
 * @property {string} [from]
 * @property {string} [to]
 * @property {ConfigValueSource} [source]
 * @property {Record<string, unknown>} [rules]
 * @property {number} [index]
 * @property {string[]} [files]
 * @property {boolean} [matched]
 * @property {unknown[]} [plugins]
 */

/**
 * Mutable state threaded through a single config resolution pass. Events are
 * recorded while configs are actually loaded and merged, so the resulting
 * report reflects the real loading order instead of being reconstructed from
 * the final config.
 *
 * @typedef {Object} ConfigResolutionContext
 * @property {string[]} extendStack - Config file paths currently being read (cycle detection)
 * @property {ConfigResolutionEvent[]} events - Recorded events in actual loading order
 */

/**
 * @returns {ConfigResolutionContext}
 */
export function createConfigResolutionContext() {
	return { extendStack: [], events: [] };
}

/**
 * @param {ConfigResolutionContext} context
 * @param {string} file
 * @returns {void}
 */
export function recordConfigFile(context, file) {
	context.events.push({ type: 'file', file });
}

/**
 * @param {ConfigResolutionContext} context
 * @param {string | undefined} from
 * @param {string} to
 * @returns {void}
 */
export function recordExtend(context, from, to) {
	context.events.push({ type: 'extend', from, to });
}

/**
 * @param {ConfigResolutionContext} context
 * @param {ConfigValueSource} source
 * @param {Record<string, unknown>} rules
 * @returns {void}
 */
export function recordLayerRules(context, source, rules) {
	context.events.push({ type: 'rules', source, rules });
}

/**
 * @param {ConfigResolutionContext} context
 * @param {string | undefined} file
 * @param {number} index
 * @param {string[]} files
 * @param {boolean} matched
 * @returns {void}
 */
export function recordOverrideEvaluation(context, file, index, files, matched) {
	context.events.push({ type: 'override', file, index, files, matched });
}

/**
 * @param {ConfigResolutionContext} context
 * @param {ConfigValueSource} source
 * @param {unknown[]} plugins
 * @returns {void}
 */
export function recordLayerPlugins(context, source, plugins) {
	context.events.push({ type: 'plugins', source, plugins });
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDisabledValue(value) {
	return value === null || value === false;
}

/**
 * Build an immutable-ish report from the recorded events. Rules that were
 * never assigned anywhere are simply absent from the report ("missing"),
 * while rules explicitly set to `null` or `false` appear under `disabled`.
 *
 * @param {ConfigResolutionContext} context
 * @param {string | undefined} root
 * @returns {ConfigResolutionReport}
 */
export function buildConfigResolutionReport(context, root) {
	/** @type {string[]} */
	const files = [];

	/** @type {ConfigResolutionReport['extends']} */
	const extendsList = [];

	/** @type {ConfigResolutionReport['overrides']} */
	const overrides = [];

	/** @type {ConfigResolutionReport['plugins']} */
	const plugins = [];

	/** @type {Map<string, Array<{ source: ConfigValueSource, value: unknown }>>} */
	const ruleHistory = new Map();

	for (const event of context.events) {
		switch (event.type) {
			case 'file': {
				if (event.file !== undefined && !files.includes(event.file)) {
					files.push(event.file);
				}

				break;
			}

			case 'extend': {
				extendsList.push({ from: event.from, to: /** @type {string} */ (event.to) });
				break;
			}

			case 'override': {
				overrides.push({
					file: event.file,
					index: /** @type {number} */ (event.index),
					files: /** @type {string[]} */ (event.files),
					matched: /** @type {boolean} */ (event.matched),
				});
				break;
			}

			case 'plugins': {
				for (const plugin of event.plugins ?? []) {
					plugins.push({ file: event.source?.file, plugin });
				}

				break;
			}

			case 'rules': {
				for (const [ruleName, value] of Object.entries(event.rules ?? {})) {
					const history = ruleHistory.get(ruleName) ?? [];

					history.push({ source: /** @type {ConfigValueSource} */ (event.source), value });
					ruleHistory.set(ruleName, history);
				}

				break;
			}

			default:
				break;
		}
	}

	/** @type {Record<string, ConfigRuleProvenance>} */
	const enabled = {};

	/** @type {Record<string, ConfigRuleProvenance>} */
	const disabled = {};

	for (const [ruleName, history] of ruleHistory) {
		const last = history.at(-1);

		if (!last) continue;

		const provenance = { source: last.source, value: last.value, history };

		if (isDisabledValue(last.value)) {
			disabled[ruleName] = provenance;
		} else {
			enabled[ruleName] = provenance;
		}
	}

	return {
		root,
		files,
		extends: extendsList,
		overrides,
		plugins,
		rules: { enabled, disabled },
	};
}
