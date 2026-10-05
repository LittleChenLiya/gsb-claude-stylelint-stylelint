import { isAbsolute, join, normalize } from 'node:path';
import process from 'node:process';

import { isDynamicPattern } from 'globby';

import createStylelint from './createStylelint.mjs';
import getConfigForFile from './getConfigForFile.mjs';
import toPath from './utils/toPath.mjs';

/**
 * Resolve the configuration for a single file and report how it was
 * resolved: the load order of config sources, the "extends" edges, the
 * applied "overrides", and the winning source of every rule value.
 *
 * The report is assembled while the configuration is loaded, so no
 * config file is read twice and no plugin is executed an extra time.
 *
 * @param {import('stylelint').LinterOptions} options
 * @returns {Promise<import('stylelint').ConfigResolutionReport | null>}
 */
export default async function reportConfig({
	cwd = process.cwd(),
	code,
	config,
	configBasedir,
	configFile,
	globbyOptions,
	files,
}) {
	const isCodeNotFile = code !== undefined;
	const filePath = files && files[0];

	if (!files || files.length !== 1 || !filePath || isCodeNotFile) {
		return Promise.reject(
			new Error('The --report-config option must be used with exactly one file path.'),
		);
	}

	if (isDynamicPattern(filePath)) {
		return Promise.reject(new Error('The --report-config option does not support globs.'));
	}

	const effectiveCwd = toPath(globbyOptions?.cwd) || cwd;

	const stylelint = createStylelint({
		config,
		configFile,
		configBasedir,
		cwd: effectiveCwd,
	});

	const absoluteFilePath = !isAbsolute(filePath)
		? join(effectiveCwd, filePath)
		: normalize(filePath);

	const resolved = await getConfigForFile({
		stylelint,
		searchPath: absoluteFilePath,
		filePath: absoluteFilePath,
	});

	return resolved?.configResolutionReport ?? null;
}
