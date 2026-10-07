export default {
	plugins: ['./counting-plugin.mjs'],
	rules: {
		'plugin/counting': true,
		'plugin/unknown-rule': true,
	},
};
