import { dirname, isAbsolute } from 'node:path';

import { globby } from 'globby';
import globjoin from 'globjoin';
import micromatch from 'micromatch';
import normalizePath from 'normalize-path';

import { RULE_SOURCES, createConfigResolutionContext } from './configResolutionReport.mjs';
import { assert, isFunction, isObject, isString } from './utils/validateTypes.mjs';
import { ConfigurationError } from './utils/errors.mjs';
import cachedImport from './utils/cachedImport.mjs';
import getCustomSyntax from './utils/getCustomSyntax.mjs';
import getLoader from './utils/getLoader.mjs';
import getModulePath from './utils/getModulePath.mjs';
import normalizeAllRuleSettings from './normalizeAllRuleSettings.mjs';
import validateLanguageOptions from './validateLanguageOptions.mjs';

/** @import {Config as StylelintConfig, ConfigRuleSource, CosmiconfigResult as StylelintCosmiconfigResult, InternalApi as StylelintInternalApi} from 'stylelint' */
/** @import {ConfigResolutionContext} from './configResolutionReport.mjs' */

// TODO: micromatch.matcher() accepts arrays at runtime, but the types don't
// reflect this. Remove the cast and func when and if upstream types are fixed.
// Ref: https://github.com/micromatch/micromatch/pull/234
const createMatcher =
	/** @type {(pattern: string | string[], options?: micromatch.Options) => (str: string) => boolean} */ (
		micromatch.matcher
	);

/**
 * @param {string} glob
 * @param {string} basedir
 * @returns {string}
 */
function absolutizeGlob(glob, basedir) {
	const result = isAbsolute(glob.replace(/^!/, '')) ? glob : globjoin(basedir, glob);

	// Glob patterns for micromatch should be in POSIX-style
	return normalizePath(result);
}

/**
 * @param {string} lookup
 * @returns {boolean}
 */
function isPathLike(lookup) {
	return lookup.startsWith('./') || lookup.startsWith('../') || isAbsolute(lookup);
}

/**
 * - Merges config and stylelint options
 * - Makes all paths absolute
 * - Merges extends
 * @param {StylelintInternalApi} stylelint
 * @param {StylelintConfig} config
 * @param {string} configDir
 * @param {boolean} allowOverrides
 * @param {string} rootConfigDir
 * @param {string} [filePath]
 * @param {string} [configFilePath] Path to the config file for caching compiled overrides
 * @param {ConfigResolutionContext} [context] Resolution context recording provenance
 * @param {ConfigRuleSource} [layerSource] Source of this config layer
 * @returns {Promise<StylelintConfig>}
 */
async function augmentConfigBasic(
	stylelint,
	config,
	configDir,
	allowOverrides,
	rootConfigDir,
	filePath,
	configFilePath,
	context,
	layerSource,
) {
	let augmentedConfig = config;

	if (context && layerSource) {
		context.seedLayer(augmentedConfig, layerSource);
	}

	if (allowOverrides) {
		augmentedConfig = addOptions(stylelint, augmentedConfig);
	}

	if (filePath) {
		augmentedConfig = applyOverrides(
			augmentedConfig,
			rootConfigDir,
			filePath,
			stylelint._compiledOverridesCache,
			configFilePath,
			context,
		);
	}

	augmentedConfig = await extendConfig(
		stylelint,
		augmentedConfig,
		configDir,
		rootConfigDir,
		filePath,
		configFilePath,
		context,
	);

	const cwd = stylelint._options.cwd;

	return absolutizePaths(augmentedConfig, configDir, cwd);
}

/**
 * Extended configs need to be run through augmentConfigBasic
 * but do not need the full treatment. Things like pluginFunctions
 * will be resolved and added by the parent config.
 * @param {string} cwd
 * @returns {(cosmiconfigResult?: StylelintCosmiconfigResult) => Promise<StylelintCosmiconfigResult>}
 */
export function augmentConfigExtended(cwd) {
	return async (cosmiconfigResult) => {
		if (!cosmiconfigResult) {
			return null;
		}

		const configDir = dirname(cosmiconfigResult.filepath || '');
		const { config } = cosmiconfigResult;

		const augmentedConfig = absolutizePaths(config, configDir, cwd);

		return {
			config: augmentedConfig,
			filepath: cosmiconfigResult.filepath,
		};
	};
}

/**
 * @param {StylelintInternalApi} stylelint
 * @param {string} [filePath]
 * @param {StylelintCosmiconfigResult} [cosmiconfigResult]
 * @returns {Promise<StylelintCosmiconfigResult>}
 */
export async function augmentConfigFull(stylelint, filePath, cosmiconfigResult) {
	if (!cosmiconfigResult) {
		return null;
	}

	const config = cosmiconfigResult.config;

	const configDir = stylelint._options.configBasedir || dirname(cosmiconfigResult.filepath || '');

	const context = createConfigResolutionContext(stylelint._options.cwd);

	// A config given directly via the `config` option has no real file path;
	// `cosmiconfigResult.filepath` is a placeholder in that case.
	const isOptionsConfig = stylelint._options.config != null && stylelint._options.config === config;

	/** @type {ConfigRuleSource} */
	const rootSource = isOptionsConfig
		? { type: 'option' }
		: { type: 'config', filepath: cosmiconfigResult.filepath };

	const rootFilepath = isOptionsConfig ? null : (cosmiconfigResult.filepath ?? null);

	const via = stylelint._options.config
		? 'config option'
		: stylelint._options.configFile
			? 'configFile option'
			: 'search';

	context.recordLoad(rootFilepath, via);

	if (cosmiconfigResult.filepath) {
		context.enterConfig(cosmiconfigResult.filepath);
	}

	let augmentedConfig;

	try {
		augmentedConfig = await augmentConfigBasic(
			stylelint,
			config,
			configDir,
			true,
			configDir,
			filePath,
			cosmiconfigResult.filepath,
			context,
			rootSource,
		);

		augmentedConfig = await addPluginFunctions(augmentedConfig, context);
		augmentedConfig = await addProcessorFunctions(augmentedConfig);
		augmentedConfig = await resolveReferenceFiles(augmentedConfig);
		augmentedConfig = await resolveCustomSyntax(augmentedConfig);
	} finally {
		if (cosmiconfigResult.filepath) {
			context.exitConfig();
		}
	}

	if (!augmentedConfig.rules) {
		throw new ConfigurationError(
			'No rules found within configuration. Have you provided a "rules" property?',
		);
	}

	augmentedConfig = await normalizeAllRuleSettings(augmentedConfig);

	validateLanguageOptions(augmentedConfig);

	const configResolutionReport = context.finalize({
		filePath,
		configFile: rootFilepath,
		config: augmentedConfig,
	});

	// Do not leak the internal provenance map into the resolved config.
	delete (/** @type {any} */ (augmentedConfig)[RULE_SOURCES]);

	return {
		config: augmentedConfig,
		filepath: cosmiconfigResult.filepath,
		configResolutionReport,
	};
}

/**
 * Make all paths in the config absolute.
 *
 * @param {StylelintConfig} config
 * @param {string} configDir
 * @param {string} cwd
 * @returns {StylelintConfig}
 */
function absolutizePaths(config, configDir, cwd) {
	if (config.ignoreFiles) {
		config.ignoreFiles = [config.ignoreFiles].flat().map((glob) => absolutizeGlob(glob, configDir));
	}

	/** @type {<T>(lookup: T) => (string | T)} */
	const toAbsolutePath = (lookup) => {
		if (typeof lookup === 'string') {
			return getModulePath(configDir, lookup, cwd);
		}

		return lookup;
	};

	if (config.plugins) {
		config.plugins = [config.plugins].flat().map(toAbsolutePath);
	}

	if (config.processors) {
		config.processors = config.processors.map(toAbsolutePath);
	}

	if (isString(config.customSyntax) && isPathLike(config.customSyntax)) {
		config.customSyntax = getModulePath(configDir, config.customSyntax, cwd);
	}

	if (config.referenceFiles) {
		config.referenceFiles = [config.referenceFiles].flat().map((entry) => {
			if (isString(entry)) {
				return { files: [absolutizeGlob(entry, configDir)] };
			}

			if (isObject(entry)) {
				return {
					files: [entry.files].flat().map((glob) => absolutizeGlob(glob, configDir)),
					customSyntax:
						isString(entry.customSyntax) && isPathLike(entry.customSyntax)
							? getModulePath(configDir, entry.customSyntax, cwd)
							: entry.customSyntax,
					loader:
						isString(entry.loader) && isPathLike(entry.loader)
							? getModulePath(configDir, entry.loader, cwd)
							: entry.loader,
				};
			}

			return entry;
		});
	}

	return config;
}

/**
 * @param {StylelintInternalApi} stylelint
 * @param {StylelintConfig} config
 * @param {string} configDir
 * @param {string} rootConfigDir
 * @param {string} [filePath]
 * @param {string} [configFilePath] Path to the config file containing the "extends"
 * @param {ConfigResolutionContext} [context] Resolution context recording provenance
 * @returns {Promise<StylelintConfig>}
 */
async function extendConfig(
	stylelint,
	config,
	configDir,
	rootConfigDir,
	filePath,
	configFilePath,
	context,
) {
	if (config.extends === undefined) {
		return config;
	}

	const { extends: configExtends, ...originalWithoutExtends } = config;
	const normalizedExtends = [configExtends].flat();

	let resultConfig = originalWithoutExtends;

	for (const extendLookup of normalizedExtends) {
		if (typeof extendLookup === 'string') {
			const extendPath = getModulePath(configDir, extendLookup, stylelint._options.cwd);

			context?.recordExtend({
				from: configFilePath ?? null,
				to: extendPath,
				specifier: extendLookup,
			});

			// Reject circular "extends" at the reader layer, reporting the chain.
			context?.enterConfig(extendPath);

			try {
				const extendResult = await stylelint._extendExplorer.load(extendPath);

				if (extendResult) {
					context?.recordLoad(extendResult.filepath ?? extendPath, 'extends');

					resultConfig = mergeConfigs(
						resultConfig,
						await augmentExtendedConfig(stylelint, extendResult, rootConfigDir, filePath, context, {
							type: 'config',
							filepath: extendResult.filepath,
						}),
					);
				}
			} finally {
				context?.exitConfig();
			}
		} else if (typeof extendLookup === 'object' && extendLookup !== null) {
			const extendResult = { config: extendLookup, filepath: undefined };

			resultConfig = mergeConfigs(
				resultConfig,
				await augmentExtendedConfig(stylelint, extendResult, rootConfigDir, filePath, context, {
					type: 'inline',
					filepath: configFilePath,
				}),
			);
		}
	}

	return mergeConfigs(resultConfig, originalWithoutExtends);
}

/**
 * Run an extended config through augmentConfigBasic and return the result.
 *
 * @param {StylelintInternalApi} stylelint
 * @param {{ config: StylelintConfig, filepath?: string | undefined }} extendResult
 * @param {string} rootConfigDir
 * @param {string} [filePath]
 * @param {ConfigResolutionContext} [context]
 * @param {ConfigRuleSource} [layerSource]
 * @returns {Promise<StylelintConfig>}
 */
async function augmentExtendedConfig(
	stylelint,
	extendResult,
	rootConfigDir,
	filePath,
	context,
	layerSource,
) {
	if (!extendResult) {
		return {};
	}

	const extendConfigDir = dirname(extendResult.filepath || '');

	return augmentConfigBasic(
		stylelint,
		extendResult.config,
		extendConfigDir,
		false,
		rootConfigDir,
		filePath,
		extendResult.filepath,
		context,
		layerSource,
	);
}

/**
 * When merging configs (via extends)
 * - plugin, extends, overrides arrays are joined
 * - rules are merged via Object.assign, so there is no attempt made to
 *   merge any given rule's settings. If b contains the same rule as a,
 *   b's rule settings will override a's rule settings entirely.
 * - Everything else is merged via Object.assign
 * @param {StylelintConfig} a
 * @param {StylelintConfig} b
 * @returns {StylelintConfig}
 */
function mergeConfigs(a, b) {
	/** @type {Pick<StylelintConfig, 'plugins'>} */
	const pluginMerger = {};

	if (a.plugins || b.plugins) {
		pluginMerger.plugins = [];

		if (a.plugins) {
			pluginMerger.plugins = pluginMerger.plugins.concat(a.plugins);
		}

		if (b.plugins) {
			pluginMerger.plugins = [...new Set(pluginMerger.plugins.concat(b.plugins))];
		}
	}

	/** @type {Pick<StylelintConfig, 'processors'>} */
	const processorMerger = {};

	if (a.processors || b.processors) {
		processorMerger.processors = [];

		if (a.processors) {
			processorMerger.processors = processorMerger.processors.concat(a.processors);
		}

		if (b.processors) {
			processorMerger.processors = [...new Set(processorMerger.processors.concat(b.processors))];
		}
	}

	/** @type {Pick<StylelintConfig, 'overrides'>} */
	const overridesMerger = {};

	if (a.overrides || b.overrides) {
		overridesMerger.overrides = [];

		if (a.overrides) {
			overridesMerger.overrides = overridesMerger.overrides.concat(a.overrides);
		}

		if (b.overrides) {
			overridesMerger.overrides = [...new Set(overridesMerger.overrides.concat(b.overrides))];
		}
	}

	/** @type {Pick<StylelintConfig, 'extends'>} */
	const extendsMerger = {};

	if (a.extends || b.extends) {
		extendsMerger.extends = [];

		if (a.extends) {
			extendsMerger.extends = extendsMerger.extends.concat(a.extends);
		}

		if (b.extends) {
			extendsMerger.extends = extendsMerger.extends.concat(b.extends);
		}

		// Remove duplicates from the array, the last item takes precedence
		extendsMerger.extends = extendsMerger.extends.filter(
			(item, index, arr) => arr.lastIndexOf(item) === index,
		);
	}

	const rulesMerger = {};

	if (a.rules || b.rules) {
		rulesMerger.rules = { ...a.rules, ...b.rules };
	}

	const result = {
		...a,
		...b,
		...extendsMerger,
		...pluginMerger,
		...processorMerger,
		...overridesMerger,
		...rulesMerger,
	};

	// Carry the per-rule source maps (if any) through the same merge
	// precedence as the rules themselves, so that the winning source of
	// every rule value is known from the actual merge order.
	const aSources = /** @type {any} */ (a)[RULE_SOURCES];
	const bSources = /** @type {any} */ (b)[RULE_SOURCES];

	if (aSources || bSources) {
		/** @type {any} */ (result)[RULE_SOURCES] = new Map([...(aSources ?? []), ...(bSources ?? [])]);
	}

	return result;
}

/**
 * @param {StylelintConfig} config
 * @param {ConfigResolutionContext} [context]
 * @returns {Promise<StylelintConfig>}
 */
async function addPluginFunctions(config, context) {
	if (!config.plugins) {
		return config;
	}

	const normalizedPlugins = [config.plugins].flat();

	/** @type {StylelintConfig['_pluginFunctions']} */
	const pluginFunctions = {};

	for (const pluginLookup of normalizedPlugins) {
		let pluginImport;

		if (typeof pluginLookup === 'string') {
			pluginImport = await cachedImport(pluginLookup);
		} else {
			pluginImport = pluginLookup;
		}

		// Handle either ES6 or CommonJS modules
		pluginImport = pluginImport.default || pluginImport;

		// A plugin can export either a single rule definition
		// or an array of them
		const normalizedPluginImport = [pluginImport].flat();

		/** @type {string[]} */
		const providedRuleNames = [];

		for (const pluginRuleDefinition of normalizedPluginImport) {
			if (!pluginRuleDefinition.ruleName) {
				throw new ConfigurationError(
					`stylelint requires plugins to expose a ruleName. The plugin "${pluginLookup}" is not doing this, so will not work with stylelint. Please file an issue with the plugin.`,
				);
			}

			if (!pluginRuleDefinition.ruleName.includes('/')) {
				throw new ConfigurationError(
					`stylelint requires plugin rules to be namespaced, i.e. only \`plugin-namespace/plugin-rule-name\` plugin rule names are supported. The plugin rule "${pluginRuleDefinition.ruleName}" does not do this, so will not work. Please file an issue with the plugin.`,
				);
			}

			pluginFunctions[pluginRuleDefinition.ruleName] = pluginRuleDefinition.rule;
			providedRuleNames.push(pluginRuleDefinition.ruleName);
		}

		context?.recordPluginResolution(
			typeof pluginLookup === 'string' ? pluginLookup : '<inline plugin>',
			providedRuleNames,
		);
	}

	config._pluginFunctions = pluginFunctions;

	return config;
}

/**
 * @param {StylelintConfig} config
 * @returns {Promise<StylelintConfig>}
 */
async function addProcessorFunctions(config) {
	if (!config.processors) {
		return config;
	}

	const processorPromises = config.processors.map(async (processorLookup) => {
		let processor = await cachedImport(processorLookup);

		processor = processor.default ?? processor;

		if (!isFunction(processor)) {
			throw new ConfigurationError(`The processor "${processorLookup}" must be a function`);
		}

		const { name, postprocess } = processor();

		if (!isString(name) || !name) {
			throw new ConfigurationError(
				`The processor "${processorLookup}" must return an object with the "name" property`,
			);
		}

		if (!isFunction(postprocess)) {
			throw new ConfigurationError(
				`The processor "${processorLookup}" must return an object with the "postprocess" property`,
			);
		}

		return { name, postprocess };
	});

	/** @type {StylelintConfig['_processorFunctions']} */
	const processorFunctions = new Map();

	(await Promise.all(processorPromises)).forEach(({ name, postprocess }) => {
		if (name) {
			processorFunctions.set(name, postprocess);
		}
	});

	config._processorFunctions = processorFunctions;

	return config;
}

/**
 * @param {StylelintConfig} config
 * @returns {Promise<StylelintConfig>}
 */
async function resolveReferenceFiles(config) {
	if (!config.referenceFiles) {
		return config;
	}

	assert(Array.isArray(config.referenceFiles));

	const resolved = config.referenceFiles.map(async (entry) => {
		if (!entry || !isObject(entry) || !entry.files) {
			throw new ConfigurationError(
				'Every entry in the "referenceFiles" configuration property must be a string or an object with a "files" property, e.g. { "referenceFiles": ["tokens.css"] }.',
			);
		}

		assert(Array.isArray(entry.files));
		const patterns = entry.files;
		const files = await globby(patterns, { absolute: true });

		if (files.length === 0) {
			throw new ConfigurationError(
				`No files matching the pattern "${patterns.join(', ')}" were found.`,
			);
		}

		const customSyntax = entry.customSyntax ? await getCustomSyntax(entry.customSyntax) : undefined;
		const loader = entry.loader ? await getLoader(entry.loader) : undefined;

		return { files, customSyntax, loader };
	});

	config._resolvedReferenceFiles = await Promise.all(resolved);

	return config;
}

/**
 * @param {StylelintConfig} config
 * @returns {Promise<StylelintConfig>}
 */
async function resolveCustomSyntax(config) {
	if (!config.customSyntax) {
		return config;
	}

	config._resolvedCustomSyntax = await getCustomSyntax(config.customSyntax);

	return config;
}

/**
 * @typedef {Object} CompiledOverride
 * @property {Object} configOverrides The config overrides to apply when matched
 * @property {string[]} files The original glob patterns of the override
 * @property {(filePath: string) => boolean} matches Pre-compiled matcher function
 */

/**
 * Pre-compile override matchers for efficient reuse across multiple files. This
 * avoids recompiling glob patterns for each file processed.
 *
 * @param {NonNullable<StylelintConfig['overrides']>} overrides
 * @param {string} rootConfigDir
 * @returns {CompiledOverride[]}
 */
export function compileOverrideMatchers(overrides, rootConfigDir) {
	return overrides.map((override) => {
		const { files, ...configOverrides } = override;

		if (!files) {
			throw new Error(
				'Every object in the `overrides` configuration property should have a `files` property with globs, e.g. { "overrides": [{ "files": "*.css", "rules": {} }] }.',
			);
		}

		const fileList = typeof files === 'string' ? [files] : files;
		const absoluteGlobs = [];
		const nonNegatedFiles = [];

		for (const glob of fileList) {
			absoluteGlobs.push(absolutizeGlob(glob, rootConfigDir));

			if (!glob.startsWith('!')) {
				nonNegatedFiles.push(glob);
			}
		}

		const absoluteMatcher = createMatcher(absoluteGlobs, { dot: true });
		const basenameMatcher =
			nonNegatedFiles.length > 0
				? createMatcher(nonNegatedFiles, { dot: true, basename: true })
				: () => false;

		return {
			configOverrides,
			files: fileList,
			matches: (filePath) => absoluteMatcher(filePath) || basenameMatcher(filePath),
		};
	});
}

/**
 * @param {StylelintConfig} fullConfig
 * @param {string} rootConfigDir
 * @param {string} filePath
 * @param {Map<string, CompiledOverride[]>} [cache] Cache for compiled matchers
 * @param {string} [configFilePath] Config file path for cache key
 * @param {ConfigResolutionContext} [context] Resolution context recording provenance
 * @returns {StylelintConfig}
 */
export function applyOverrides(
	fullConfig,
	rootConfigDir,
	filePath,
	cache,
	configFilePath,
	context,
) {
	const { overrides, ...rest } = fullConfig;
	let config = rest;

	if (!overrides) {
		return config;
	}

	if (!Array.isArray(overrides)) {
		throw new TypeError(
			'The `overrides` configuration property should be an array, e.g. { "overrides": [{ "files": "*.css", "rules": {} }] }.',
		);
	}

	let matchers;

	if (cache && configFilePath) {
		const cacheKey = `${configFilePath}::${rootConfigDir}`;

		matchers = cache.get(cacheKey);

		if (!matchers) {
			matchers = compileOverrideMatchers(overrides, rootConfigDir);
			cache.set(cacheKey, matchers);
		}
	} else {
		matchers = compileOverrideMatchers(overrides, rootConfigDir);
	}

	for (const [index, { configOverrides, files, matches }] of matchers.entries()) {
		const matched = matches(filePath);

		context?.recordOverride({ index, files, matched, configFile: configFilePath });

		if (matched) {
			config = mergeConfigs(config, configOverrides);

			if (context) {
				/** @type {ConfigRuleSource} */
				const source = { type: 'override', filepath: configFilePath, index, files };

				/** @type {Map<string, { value: unknown, source: ConfigRuleSource }>} */
				const ruleSources = new Map(/** @type {any} */ (config)[RULE_SOURCES] ?? []);

				const overrideRules = /** @type {StylelintConfig} */ (configOverrides).rules;

				for (const [ruleName, value] of Object.entries(overrideRules ?? {})) {
					const entry = { value, source };

					ruleSources.set(ruleName, entry);
					context.recordRuleEvent(ruleName, entry);
				}

				/** @type {any} */ (config)[RULE_SOURCES] = ruleSources;
			}
		}
	}

	return config;
}

/**
 * Add options to the config
 *
 * @param {StylelintInternalApi} stylelint
 * @param {StylelintConfig} config
 *
 * @returns {StylelintConfig}
 */
function addOptions(stylelint, config) {
	const augmentedConfig = {
		...config,
	};

	const subset = /** @type {const} */ ([
		'customSyntax',
		'fix',
		'computeEditInfo',
		'ignoreDisables',
		'quiet',
		'reportDescriptionlessDisables',
		'reportInvalidScopeDisables',
		'reportNeedlessDisables',
		'reportUnscopedDisables',
		'maxWarnings',
		'validate',
	]);

	/** @type {Partial<StylelintConfig>} */
	const options = {
		...stylelint._options,
		// Override fix to match Config type.
		fix: stylelint._options.fix ? Boolean(stylelint._options.fix) : undefined,
	};

	/**
	 * @template T
	 * @param {T extends typeof subset[number] ? T : never} key
	 */
	const addOption = (key) => {
		const value = options[key];

		if (value) {
			augmentedConfig[key] = value;
		}
	};

	subset.forEach((key) => addOption(key));

	return augmentedConfig;
}
