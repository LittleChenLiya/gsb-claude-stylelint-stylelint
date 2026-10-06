import stylelint from '../../index.mjs';

const {
	createPlugin,
	utils: { report, ruleMessages, validateOptions },
} = stylelint;

const ruleName = 'test/fix-plan-beta';

const messages = ruleMessages(ruleName, {
	rejected: (value) => `Unexpected value "${value}", expected "1rem"`,
});

const rule = (primary) => {
	return (root, result) => {
		const validOptions = validateOptions(result, ruleName, {
			actual: primary,
			possible: [true],
		});

		if (!validOptions) return;

		root.walkDecls('bar', (decl) => {
			if (decl.value === '1rem') return;

			report({
				result,
				ruleName,
				message: messages.rejected(decl.value),
				node: decl,
				fix: {
					node: decl,
					apply: () => {
						decl.value = '1rem';
					},
				},
			});
		});
	};
};

rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = { fixable: true };

export default createPlugin(ruleName, rule);
