import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NO_CHANGES_NOTE } from "./version-utils.mjs";
import { prepareRelease, releasePending } from "./release-prepare-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Folds the changelog.d fragments into a new CHANGELOG.md section, writes the next calendar version into
// VERSION, package.json, package-lock.json and the OpenAPI document, and deletes the fragments. It
// commits, tags and pushes nothing; the release workflow (or docs/releasing.md) does the rest.
// `--pending` only prints whether anything is waiting to be released, using Node built-ins alone.
async function main() {
	if (process.argv.includes("--pending")) {
		process.stdout.write(`${releasePending(root)}\n`);
		return;
	}
	const result = await prepareRelease({
		root,
		writeOpenApi: async () => {
			// Loaded only here: rendering the OpenAPI document needs TypeScript and Prettier.
			const { openApiPath, renderOpenApi } = await import("./docs-generate.mjs");
			writeFileSync(openApiPath, await renderOpenApi());
		},
	});
	process.stdout.write(
		`Prepared ${result.version} (package.json ${result.npmVersion}) from ${result.fragments} fragment(s).${result.empty ? ` There were no changelog entries, so it says "${NO_CHANGES_NOTE}"` : ""} Review CHANGELOG.md, then commit it as "chore(release): ${result.version}" on a release/* branch (docs/releasing.md).\n`,
	);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
