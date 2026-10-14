import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Bundles one `src/lib/finance/*` file (TypeScript, relative imports) and imports it. */
export async function loadFinance(name) {
	const outDir = makeBundleDirectory(`kite-finance-${name}-`);
	after(() => rmSync(outDir, { recursive: true, force: true }));
	const outfile = join(outDir, `${name}.mjs`);
	await build({
		entryPoints: [join(root, `src/lib/finance/${name}.ts`)],
		outfile,
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
	});
	return import(pathToFileURL(outfile).href);
}
