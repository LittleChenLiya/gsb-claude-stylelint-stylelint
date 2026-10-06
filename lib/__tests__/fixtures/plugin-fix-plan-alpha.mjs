import stylelint from '../../index.mjs';

const {
	createPlugin,
	utils: { report, ruleMessages, validateOptions },
} = stylelint;

const ruleName = 'test/fix-plan-alpha';

const messages = ruleMessages(ruleName, {
	rejected: (value) => `Unexpected value "${value}", expected "one"`,
});

const rule = (primary) => {
	return (root, result) => {
		const validOptions = validateOptions(result, ruleName, {
			actual: primary,
			possible: [true],
		});

		if (!validOptions) return;

		root.walkDecls('foo', (decl) => {
			if (decl.value === 'one') return;

			report({
				result,
				ruleName,
				message: messages.rejected(decl.value),
				node: decl,
				fix: {
					node: decl,
					apply: () => {
						decl.value = 'one';
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
