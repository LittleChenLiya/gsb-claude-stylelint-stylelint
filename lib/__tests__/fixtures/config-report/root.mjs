export default {
	extends: ['./mid.mjs'],
	rules: {
		'color-hex-length': 'short',
	},
	overrides: [
		{
			files: ['*.scss'],
			rules: {
				'declaration-no-important': null,
				'max-nesting-depth': [2, { severity: 'warning' }],
			},
		},
		{
			files: ['*.less'],
			rules: {
				'color-hex-length': null,
			},
		},
	],
};
