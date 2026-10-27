import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { changedFragmentFiles, pullRequestLabels, resolveBase } from "../scripts/release-check-utils.mjs";
import { prepareRelease, releasePending } from "../scripts/release-prepare-utils.mjs";

const directories = [];
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function scratch() {
	const directory = mkdtempSync(join(tmpdir(), "kite-release-"));
	directories.push(directory);
	return directory;
}

const respond =
	(body, ok = true) =>
	async () => ({ ok, json: async () => body });
const ci = { PR_NUMBER: "132", GITHUB_TOKEN: "token", GITHUB_REPOSITORY: "midego1/kite" };

test("labels are read live from the API, so a rerun sees a label added later", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, auth: init.headers.authorization });
		return { ok: true, json: async () => [{ name: "no-changelog" }, { name: "ui" }] };
	};
	assert.deepEqual(await pullRequestLabels({ ...ci, PR_LABELS: "[]" }, fetchImpl), ["no-changelog", "ui"]);
	assert.deepEqual(calls, [
		{ url: "https://api.github.com/repos/midego1/kite/issues/132/labels?per_page=100", auth: "Bearer token" },
	]);
});

test("labels fall back to the event's PR_LABELS when the API cannot answer", async () => {
	const event = { ...ci, PR_LABELS: '["no-changelog"]' };
	assert.deepEqual(await pullRequestLabels(event, respond({}, false)), ["no-changelog"]);
	assert.deepEqual(
		await pullRequestLabels(event, async () => {
			throw new Error("offline");
		}),
		["no-changelog"],
	);
	// Without a usable PR number or repository the API is not called at all.
	const never = async () => assert.fail("fetch must not be called");
	assert.deepEqual(await pullRequestLabels({ ...event, PR_NUMBER: "1/../2" }, never), ["no-changelog"]);
	assert.deepEqual(await pullRequestLabels({ ...event, GITHUB_REPOSITORY: "a/b?x" }, never), ["no-changelog"]);
	assert.deepEqual(await pullRequestLabels({ PR_LABELS: "null" }, never), []);
	assert.deepEqual(await pullRequestLabels({ PR_LABELS: "{not json" }, never), []);
	assert.deepEqual(await pullRequestLabels({}, never), []);
});

/** A fake `git` for resolveBase: the commit HEAD names and which objects exist or can be fetched. */
function fakeGit({ head, present = [], fetchable = [] }) {
	const calls = [];
	const git = (...args) => {
		calls.push(args.join(" "));
		if (args[0] === "cat-file" && args[1] === "-p") {
			if (head === null) throw new Error("no HEAD");
			return head;
		}
		if (args[0] === "cat-file" && args[1] === "-e") {
			if (!present.includes(args[2].replace("^{commit}", ""))) throw new Error("missing");
			return "";
		}
		if (args[0] === "fetch") {
			if (!fetchable.includes(args.at(-1))) throw new Error("fetch failed");
			return "";
		}
		throw new Error(`unexpected git ${args.join(" ")}`);
	};
	return { git, calls };
}
const mergeHead = "tree t\nparent basesha\nparent headsha\nauthor a\n\nMerge";

test("on a pull request the base is the merge commit's first parent, fetched when missing", () => {
	assert.equal(
		resolveBase(fakeGit({ head: mergeHead, present: ["basesha"] }).git, "event", { pullRequest: true }),
		"basesha",
	);
	const fetched = fakeGit({ head: mergeHead, fetchable: ["basesha"] });
	assert.equal(resolveBase(fetched.git, "event", { pullRequest: true }), "basesha");
	assert.ok(fetched.calls.includes("fetch --no-tags --depth=1 origin basesha"));
	assert.equal(resolveBase(fakeGit({ head: mergeHead }).git, "event", { pullRequest: true }), "event");
	assert.equal(
		resolveBase(fakeGit({ head: "tree t\nparent one\n\nmsg" }).git, "event", { pullRequest: true }),
		"event",
	);
	assert.equal(resolveBase(fakeGit({ head: null }).git, "event", { pullRequest: true }), "event");
	// A local merge commit has two parents too, but its first parent is the branch, not the base.
	const local = fakeGit({ head: mergeHead, present: ["basesha"] });
	assert.equal(resolveBase(local.git, "origin/main"), "origin/main");
	assert.deepEqual(local.calls, []);
});

test("changed fragments come from the diff against the base, without the README", () => {
	const calls = [];
	const git = (...args) => {
		calls.push(args.join(" "));
		return "changelog.d/a.md\nchangelog.d/README.md\nchangelog.d/notes.txt\n\nchangelog.d/b.md";
	};
	assert.deepEqual(changedFragmentFiles(git, "base"), ["changelog.d/a.md", "changelog.d/b.md"]);
	assert.deepEqual(calls, ["diff --name-only --diff-filter=AMR base HEAD -- changelog.d"]);
});

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [2026.10.27.2] - 2026-10-27\n\n### Fixed\n\n- Older.\n";

/** A minimal checkout with the files release:prepare reads and writes. */
function checkout({ fragments = {}, changelog = CHANGELOG } = {}) {
	const root = scratch();
	writeFileSync(join(root, "VERSION"), "2026.10.27.2\n");
	writeFileSync(join(root, "package.json"), '{\n\t"name": "kite",\n\t"version": "2026.10.27",\n\t"private": true\n}\n');
	writeFileSync(
		join(root, "package-lock.json"),
		`${JSON.stringify({ name: "kite", version: "2026.10.27", packages: { "": { version: "2026.10.27" } } }, null, 2)}\n`,
	);
	writeFileSync(join(root, "CHANGELOG.md"), changelog);
	mkdirSync(join(root, "changelog.d"));
	writeFileSync(join(root, "changelog.d", "README.md"), "# Fragments\n");
	for (const [name, text] of Object.entries(fragments)) writeFileSync(join(root, "changelog.d", name), text);
	return root;
}

test("release:prepare folds the fragments, bumps every version file and deletes the fragments", async () => {
	const root = checkout({
		fragments: {
			"b.md": "### Fixed\n\n- Second fix.\n",
			"a.md": "### Added\n\n- A feature.\n\n### Fixed\n\n- First fix.\n",
		},
	});
	assert.equal(releasePending(root), true);
	let openApiWrites = 0;
	const result = await prepareRelease({
		root,
		now: new Date("2026-10-28T08:00:00Z"),
		writeOpenApi: async () => {
			openApiWrites += 1;
			assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "2026.10.28.0\n");
		},
	});
	assert.deepEqual(result, { version: "2026.10.28.0", npmVersion: "2026.10.28", fragments: 2, empty: false });
	assert.equal(openApiWrites, 1);
	assert.match(readFileSync(join(root, "package.json"), "utf8"), /^\t"version": "2026\.10\.28",$/m);
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	assert.equal(lock.version, "2026.10.28");
	assert.equal(lock.packages[""].version, "2026.10.28");
	assert.equal(
		readFileSync(join(root, "CHANGELOG.md"), "utf8"),
		"# Changelog\n\n## [Unreleased]\n\n## [2026.10.28.0] - 2026-10-28\n\n### Added\n\n- A feature.\n\n### Fixed\n\n- First fix.\n- Second fix.\n\n## [2026.10.27.2] - 2026-10-27\n\n### Fixed\n\n- Older.\n",
	);
	assert.equal(existsSync(join(root, "changelog.d", "a.md")), false);
	assert.equal(existsSync(join(root, "changelog.d", "b.md")), false);
	assert.equal(existsSync(join(root, "changelog.d", "README.md")), true);
	assert.equal(releasePending(root), false);
});

test("release:prepare refuses malformed fragments before writing anything", async () => {
	const root = checkout({ fragments: { "bad.md": "- no heading\n" } });
	await assert.rejects(
		prepareRelease({ root, writeOpenApi: async () => assert.fail("nothing may be written") }),
		/Fix the changelog fragments first:\n- bad\.md: text before/,
	);
	assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "2026.10.27.2\n");
	assert.equal(existsSync(join(root, "changelog.d", "bad.md")), true);
});

test("release:prepare also releases entries left under Unreleased", async () => {
	const root = checkout({
		changelog: CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- Legacy.\n"),
	});
	assert.equal(releasePending(root), true);
	const result = await prepareRelease({ root, now: new Date("2026-10-28T08:00:00Z"), writeOpenApi: async () => {} });
	assert.equal(result.empty, false);
	assert.match(
		readFileSync(join(root, "CHANGELOG.md"), "utf8"),
		/## \[2026\.10\.28\.0\] - 2026-10-28\n\n### Fixed\n\n- Legacy\./,
	);
});

test("release:prepare --pending answers with Node built-ins only", () => {
	const output = execFileSync("node", ["scripts/release-prepare.mjs", "--pending"], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
	});
	assert.match(output, /^(true|false)\n$/);
});
