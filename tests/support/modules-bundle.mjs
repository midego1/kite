import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./bundle-directory.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The handler modules reach real services (database, IMAP, calendar tools) that these tests never call.
 * Bundling them would re-bundle gated utility files with different tree-shaking and anonymous function
 * names, which the per-file coverage merge reads as extra uncovered functions, so core-facing imports
 * from a module's server.ts resolve to an inert stub.
 */
const SERVICES = /^@\/(db(\/|$)|lib\/cloudflare$|lib\/calendar\/tools$|lib\/booking\/|lib\/import\/)/;
const stubServiceImports = {
	name: "stub-service-imports",
	setup(build) {
		build.onResolve({ filter: SERVICES }, (args) =>
			/src\/lib\/modules\/[a-z]+\/server\.ts$/.test(args.importer) ? { path: args.path, namespace: "stub" } : undefined,
		);
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "module.exports = new Proxy({}, { get: () => () => undefined });",
			loader: "js",
		}));
	},
};

/** Bundles the module platform sources the way the other app tests bundle theirs. */
export async function bundleModules(prefix, exports) {
	const directory = makeBundleDirectory(prefix);
	after(() => rmSync(directory, { recursive: true, force: true }));
	await build({
		stdin: {
			contents: exports.map(([names, file]) => `export { ${names} } from "./${file}";`).join("\n"),
			resolveDir: root,
			sourcefile: "modules-test-entry.ts",
		},
		outfile: join(directory, "entry.mjs"),
		bundle: true,
		sourcemap: "inline",
		absWorkingDir: root,
		platform: "node",
		format: "esm",
		target: "node22",
		tsconfig: join(root, "tsconfig.json"),
		packages: "external",
		alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
		plugins: [stubServiceImports],
		logLevel: "silent",
	});
	return import(pathToFileURL(join(directory, "entry.mjs")).href);
}
