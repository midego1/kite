import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fragmentProblems, readFragments } from "./changelog-fragments.mjs";
import { ALLOWANCE_DIRECTORY, isAllowanceFile } from "./quality/bundle-budget-utils.mjs";
import {
	changelogSection,
	hasPendingChanges,
	NO_CHANGES_NOTE,
	nextVersion,
	packageVersion,
	releaseChangelog,
} from "./version-utils.mjs";

/** Whether `root` has anything to release: fragments in changelog.d or entries under "Unreleased". */
export function releasePending(root) {
	return hasPendingChanges(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), readFragments(root));
}

/** The indentation `text` (a JSON document) is written with: a tab or the first line's run of spaces. */
export function jsonIndent(text) {
	return /^([\t ]+)\S/m.exec(text)?.[1] ?? "\t";
}

/** Serializes `value` like the JSON file `original` was written: same indentation and trailing newline. */
export function stringifyLike(original, value) {
	return `${JSON.stringify(value, null, jsonIndent(original))}${original.endsWith("\n") ? "\n" : ""}`;
}

/**
 * Folds the changelog.d fragments of `root` into a new CHANGELOG.md section, writes the next calendar
 * version into VERSION, package.json and package-lock.json, deletes the fragments (and the bundle growth
 * allowances in bundle-growth.d, which only mattered to the pull requests that added them), then lets
 * `writeOpenApi` rewrite the OpenAPI document (it reads the new VERSION). Malformed fragments are refused
 * before anything is written. Returns the version and whether the release says NO_CHANGES_NOTE.
 */
export async function prepareRelease({ root, now = new Date(), writeOpenApi }) {
	const file = (name) => path.join(root, name);
	const fragments = readFragments(root);
	const problems = fragmentProblems(fragments);
	if (problems.length) throw new Error(`Fix the changelog fragments first:\n- ${problems.join("\n- ")}`);
	const version = nextVersion(readFileSync(file("VERSION"), "utf8"), now);
	const npmVersion = packageVersion(version);
	const changelog = releaseChangelog(readFileSync(file("CHANGELOG.md"), "utf8"), version, now, fragments);

	const pkg = readFileSync(file("package.json"), "utf8");
	const versionLine = /^(\t"version": )"[^"]*"/m;
	if (!versionLine.test(pkg)) throw new Error('package.json has no top-level "version" line');
	const lockText = readFileSync(file("package-lock.json"), "utf8");
	const lock = JSON.parse(lockText);
	lock.version = npmVersion;
	lock.packages[""].version = npmVersion;

	writeFileSync(file("VERSION"), `${version}\n`);
	writeFileSync(file("package.json"), pkg.replace(versionLine, `$1"${npmVersion}"`));
	writeFileSync(file("package-lock.json"), stringifyLike(lockText, lock));
	writeFileSync(file("CHANGELOG.md"), changelog);
	for (const fragment of fragments) rmSync(fragment.path);
	const allowances = file(ALLOWANCE_DIRECTORY);
	if (existsSync(allowances))
		for (const name of readdirSync(allowances))
			if (isAllowanceFile(`${ALLOWANCE_DIRECTORY}/${name}`)) rmSync(path.join(allowances, name));
	await writeOpenApi();
	return {
		version,
		npmVersion,
		fragments: fragments.length,
		empty: changelogSection(changelog, version) === NO_CHANGES_NOTE,
	};
}
