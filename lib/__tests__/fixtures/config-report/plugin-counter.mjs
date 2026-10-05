import stylelint from '../../../index.mjs';

globalThis.__configReportPluginLoadCount = (globalThis.__configReportPluginLoadCount ?? 0) + 1;

const ruleName = 'plugin/counter';

const counterRule = (primary) => {
	return (root, result) => {
		if (primary !== true) return;

		root.walkRules((rule) => {
			stylelint.utils.report({
				result,
				ruleName,
				message: `counted ${rule.selector}`,
				node: rule,
			});
		});
	};
};

counterRule.ruleName = ruleName;

export default stylelint.createPlugin(ruleName, counterRule);
