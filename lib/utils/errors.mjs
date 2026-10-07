import { EXIT_CODE_INVALID_CONFIG, EXIT_CODE_INVALID_USAGE } from '../constants.mjs';

export class ConfigurationError extends Error {
	name = 'ConfigurationError';

	code = EXIT_CODE_INVALID_CONFIG;

	/**
	 * @param {string} message
	 */
	constructor(message) {
		super(message);
	}
}

export class AllFilesIgnoredError extends Error {
	name = 'AllFilesIgnoredError';

	constructor() {
		super(
			'All input files were ignored because of the ignore pattern. Either change your input, ignore pattern or use "--allow-empty-input" to allow no inputs',
		);
	}
}

export class NoFilesFoundError extends Error {
	name = 'NoFilesFoundError';

	/**
	 * @param {string|string[]} fileList
	 */
	constructor(fileList) {
		super();

		if (typeof fileList === 'string') {
			fileList = [fileList];
		}

		const pattern = fileList.filter((i) => !i.startsWith('!')).join(', ');

		this.message = `No files matching the pattern "${pattern}" were found.`;
	}
}

/**
 * Thrown by Stylelint itself (e.g. by rule-facing utilities such as
 * `utils.report()`) when a rule uses the Stylelint API incorrectly.
 *
 * Unlike {@link RuleError}, the problem is in the framework's contract with
 * the rule, so the original error is reported as-is instead of being wrapped
 * as a rule runtime failure.
 */
export class StylelintInternalError extends Error {
	name = 'StylelintInternalError';

	/**
	 * @param {string} message
	 */
	constructor(message) {
		super(message);
	}
}

/**
 * Thrown when a rule itself fails while linting a source file.
 *
 * A rule failure is an internal error of the linter (or of a plugin),
 * not a lint violation, so it must not be turned into a warning.
 */
export class RuleError extends Error {
	name = 'RuleError';

	/**
	 * @param {string} ruleName
	 * @param {string | undefined} filePath
	 * @param {{ cause?: unknown }} [options]
	 */
	constructor(ruleName, filePath, options) {
		const location = filePath ?? '<input css>';

		super(`Rule "${ruleName}" errored while linting "${location}"`, options);
	}
}

export class SuppressionFileNotFoundError extends Error {
	name = 'SuppressionFileNotFoundError';

	code = EXIT_CODE_INVALID_USAGE;

	constructor() {
		super(
			'The suppressions file does not exist. Please run the command with "--suppress" or "--suppress=<rule>" to create it.',
		);
	}
}
