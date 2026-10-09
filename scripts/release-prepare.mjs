import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApiPath, renderOpenApi } from "./docs-generate.mjs";
import { nextVersion, packageVersion, releaseChangelog } from "./version-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = (name) => path.join(root, name);

// Writes the next calendar version into VERSION, package.json, package-lock.json, CHANGELOG.md and the
// OpenAPI document. It commits, tags and pushes nothing; docs/releasing.md lists the steps after it.
async function main() {
	const now = new Date();
	const version = nextVersion(readFileSync(file("VERSION"), "utf8"), now);
	const npmVersion = packageVersion(version);
	const changelog = releaseChangelog(readFileSync(file("CHANGELOG.md"), "utf8"), version, now);

	const pkg = readFileSync(file("package.json"), "utf8");
	const versionLine = /^(\t"version": )"[^"]*"/m;
	if (!versionLine.test(pkg)) throw new Error('package.json has no top-level "version" line');
	const lock = JSON.parse(readFileSync(file("package-lock.json"), "utf8"));
	lock.version = npmVersion;
	lock.packages[""].version = npmVersion;

	writeFileSync(file("VERSION"), `${version}\n`);
	writeFileSync(file("package.json"), pkg.replace(versionLine, `$1"${npmVersion}"`));
	writeFileSync(file("package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
	writeFileSync(file("CHANGELOG.md"), changelog);
	// renderOpenApi reads info.version from the VERSION file written above.
	writeFileSync(openApiPath, await renderOpenApi());
	process.stdout.write(
		`Prepared ${version} (package.json ${npmVersion}). Review CHANGELOG.md, then follow docs/releasing.md.\n`,
	);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
