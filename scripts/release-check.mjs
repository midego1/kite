import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseBump } from "./version-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Every merge to main deploys production, so every pull request has to be its own release. Uses
// only Node built-ins, so CI can run it without installing dependencies.
function main() {
	const base = process.argv[2];
	if (!base || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)) {
		console.error("Usage: release-check.mjs <base-ref>");
		return 2;
	}
	let baseVersion;
	try {
		baseVersion = execFileSync("git", ["show", `${base}:VERSION`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		console.error(`Could not read VERSION at ${base}; fetch that revision first.`);
		return 2;
	}
	const headVersion = readFileSync(path.join(root, "VERSION"), "utf8");
	const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
	const problems = checkReleaseBump({ baseVersion, headVersion, changelog });
	if (!problems.length) {
		console.log(`Release ${headVersion.trim()} follows ${baseVersion.trim()} at ${base}.`);
		return 0;
	}
	console.error(problems.map((problem) => `- ${problem}`).join("\n"));
	console.error(
		"\nEvery merge to main is a release. Run `npm run release:prepare` as the last commit of this branch (see docs/releasing.md).",
	);
	return 1;
}

process.exitCode = main();
