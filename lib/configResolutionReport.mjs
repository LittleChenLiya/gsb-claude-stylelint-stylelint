import { dirname } from 'node:path';

import { ConfigurationError } from './utils/errors.mjs';
import coreRules from './rules/index.mjs';
import getModulePath from './utils/getModulePath.mjs';

/** @import {Config as StylelintConfig, ConfigResolutionReport, ConfigRuleSource} from 'stylelint' */

/**
 * Symbol key under which per-rule source maps are carried through config
 * merges while a configuration is being augmented. The map for a config
 * object records, for every rule name, the raw value and the source that
 * last set it, following the exact same merge order as the config itself.
 */
export const RULE_SOURCES = Symbol('stylelint.ruleSources');

/** @typedef {{ value: unknown, source: ConfigRuleSource }} RuleSourceEntry */
/** @typedef {{ name: string, source: ConfigRuleSource, configDir?: string }} PluginDeclaration */
/** @typedef {{ name: string, rules: string[] }} PluginResolution */

/**
 * Whether a raw rule value disables the rule.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isDisabledValue(value) {
	return (
		value === null ||
		value === undefined ||
		(Array.isArray(value) && value.length > 0 && (value[0] === null || value[0] === undefined))
	);
}

/**
 * Records how a configuration is resolved, while it is being resolved.
 * The recorded data is later finalized into a `ConfigResolutionReport`.
 * Nothing in this context loads files or executes plugins; it only
 * observes the resolution that is already happening.
 */
export class ConfigResolutionContext {
	/** @type {string[]} */
	#extendsChain = [];

	/** @type {string} */
	#cwd;

	/** @type {Array<{ filepath: string | null, via: string }>} */
	loadOrder = [];

	/** @type {Array<{ from: string | null, to: string, specifier: string }>} */
	extendsEdges = [];

	/** @type {Array<{ index: number, files: string[], matched: boolean, configFile: string | undefined }>} */
	overrideApplications = [];

	/** @type {PluginDeclaration[]} */
	pluginDeclarations = [];

	/** @type {PluginResolution[]} */
	pluginResolutions = [];

	/** @type {Map<string, RuleSourceEntry[]>} */
	ruleEvents = new Map();

	/**
	 * @param {string} cwd
	 */
	constructor(cwd) {
		this.#cwd = cwd;
	}

	/**
	 * Mark a config file as being loaded through "extends". Throws a
	 * ConfigurationError with the full chain when a circular extends
	 * is detected.
	 *
	 * @param {string} filepath
	 * @returns {void}
	 */
	enterConfig(filepath) {
		const index = this.#extendsChain.indexOf(filepath);

		if (index !== -1) {
			const cycle = [...this.#extendsChain.slice(index), filepath].join(' -> ');

			throw new ConfigurationError(`Circular configuration extends detected: ${cycle}`);
		}

		this.#extendsChain.push(filepath);
	}

	/**
	 * Leave the config file most recently entered.
	 *
	 * @returns {void}
	 */
	exitConfig() {
		this.#extendsChain.pop();
	}

	/**
	 * Record that a config source was loaded.
	 *
	 * @param {string | null | undefined} filepath
	 * @param {string} via
	 * @returns {void}
	 */
	recordLoad(filepath, via) {
		this.loadOrder.push({ filepath: filepath ?? null, via });
	}

	/**
	 * Record an "extends" edge between two config sources.
	 *
	 * @param {{ from: string | null, to: string, specifier: string }} edge
	 * @returns {void}
	 */
	recordExtend(edge) {
		this.extendsEdges.push(edge);
	}

	/**
	 * Record whether a single override block matched the linted file.
	 *
	 * @param {{ index: number, files: string[], matched: boolean, configFile: string | undefined }} application
	 * @returns {void}
	 */
	recordOverride(application) {
		this.overrideApplications.push(application);
	}

	/**
	 * Record a rule value assignment in load order.
	 *
	 * @param {string} ruleName
	 * @param {RuleSourceEntry} entry
	 * @returns {void}
	 */
	recordRuleEvent(ruleName, entry) {
		const events = this.ruleEvents.get(ruleName) ?? [];

		events.push(entry);
		this.ruleEvents.set(ruleName, events);
	}

	/**
	 * Seed a config layer: record its own rule values and plugin
	 * declarations, and attach the per-rule source map that is carried
	 * through subsequent merges.
	 *
	 * @param {StylelintConfig} config
	 * @param {ConfigRuleSource} source
	 * @returns {void}
	 */
	seedLayer(config, source) {
		/** @type {Map<string, RuleSourceEntry>} */
		const ruleSources = new Map();

		if (config.rules) {
			for (const [ruleName, value] of Object.entries(config.rules)) {
				/** @type {RuleSourceEntry} */
				const entry = { value, source };

				ruleSources.set(ruleName, entry);
				this.recordRuleEvent(ruleName, entry);
			}
		}

		/** @type {any} */ (config)[RULE_SOURCES] = ruleSources;

		if (config.plugins) {
			const configDir = source.filepath ? dirname(source.filepath) : undefined;

			for (const plugin of [config.plugins].flat()) {
				if (typeof plugin === 'string') {
					this.pluginDeclarations.push({ name: plugin, source, configDir });
				}
			}
		}
	}

	/**
	 * Record a resolved plugin and the rule names it provides.
	 *
	 * @param {string} name - Resolved plugin lookup (absolute path) or a placeholder
	 * @param {string[]} rules - Rule names exposed by the plugin
	 * @returns {void}
	 */
	recordPluginResolution(name, rules) {
		this.pluginResolutions.push({ name, rules });
	}

	/**
	 * Resolve a recorded plugin declaration to its absolute path, reusing
	 * the (already warm) module path cache. Returns `undefined` when the
	 * declaration cannot be resolved.
	 *
	 * @param {PluginDeclaration} declaration
	 * @returns {string | undefined}
	 */
	#resolveDeclaration(declaration) {
		if (!declaration.configDir) return undefined;

		try {
			return getModulePath(declaration.configDir, declaration.name, this.#cwd);
		} catch {
			return undefined;
		}
	}

	/**
	 * Build the final report from everything recorded during resolution.
	 *
	 * @param {object} details
	 * @param {string | undefined} details.filePath - The file the config was resolved for
	 * @param {string | null} details.configFile - The root config file, if any
	 * @param {StylelintConfig} details.config - The fully augmented config
	 * @returns {ConfigResolutionReport}
	 */
	finalize({ filePath, configFile, config }) {
		/** @type {Map<string, RuleSourceEntry> | undefined} */
		const finalSources = /** @type {any} */ (config)[RULE_SOURCES];

		const knownPluginRules = new Set(this.pluginResolutions.flatMap(({ rules }) => rules));

		/** @type {ConfigResolutionReport['rules']} */
		const rules = {};

		/** @type {string[]} */
		const unknownRules = [];

		for (const [ruleName, entry] of finalSources ?? []) {
			rules[ruleName] = {
				status: isDisabledValue(entry.value) ? 'disabled' : 'enabled',
				value: entry.value,
				source: entry.source,
				history: this.ruleEvents.get(ruleName) ?? [],
			};

			if (!(ruleName in coreRules) && !knownPluginRules.has(ruleName)) {
				unknownRules.push(ruleName);
			}
		}

		const plugins = this.pluginResolutions.map(({ name, rules: pluginRules }) => {
			const declaredIn = this.pluginDeclarations
				.filter((declaration) => this.#resolveDeclaration(declaration) === name)
				.map((declaration) => declaration.source);

			return { name, rules: pluginRules, declaredIn };
		});

		return {
			version: 1,
			filePath: filePath ?? null,
			configFile,
			loadOrder: this.loadOrder,
			extends: this.extendsEdges,
			overrides: this.overrideApplications,
			plugins,
			rules,
			unknownRules,
		};
	}
}

/**
 * Create a fresh resolution context for a single config resolution.
 *
 * @param {string} cwd
 * @returns {ConfigResolutionContext}
 */
export function createConfigResolutionContext(cwd) {
	return new ConfigResolutionContext(cwd);
}
