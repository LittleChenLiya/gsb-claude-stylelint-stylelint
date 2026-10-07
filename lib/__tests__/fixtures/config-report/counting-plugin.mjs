globalThis.__configReportPluginEvals = (globalThis.__configReportPluginEvals ?? 0) + 1;

const ruleName = 'plugin/counting';

const rule = () => {
	globalThis.__configReportPluginRuns = (globalThis.__configReportPluginRuns ?? 0) + 1;

	return () => {};
};

rule.ruleName = ruleName;

export default { ruleName, rule };
