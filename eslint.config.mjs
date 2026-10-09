import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
	{
		ignores: [
			".next/**",
			".next-node/**",
			".vinext/**",
			".wrangler/**",
			"node_modules/**",
			"drizzle/**",
			"dist/**",
			"test-results/**",
			"playwright-report/**",
			"data/**",
			"deploy/**/node_modules/**",
			"cloudflare-env.d.ts",
			"next-env.d.ts",
		],
	},
	...nextCoreWebVitals,
	...nextTypescript,
	{
		files: ["src/**/*.{ts,tsx,mjs}", "server/**/*.{ts,mjs}", "worker*.ts", "deploy/cloudflare-email-relay/src/**/*.ts"],
		rules: {
			complexity: ["warn", 20],
			"max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
		},
	},
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
			],
		},
	},
];

export default eslintConfig;
