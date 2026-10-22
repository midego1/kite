import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compareVersions } from "../scripts/version-utils.mjs";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-changelog-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/changelog/changelog-utils.ts")],
	outfile: join(bundleDirectory, "changelog.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	packages: "external",
	logLevel: "silent",
});
const { changelogReleaseLabel, isAppChangelogHref, parseChangelog, parseInlineMarkdown } = await import(
	pathToFileURL(join(bundleDirectory, "changelog.mjs")).href
);

const markdown = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const currentVersion = readFileSync(join(root, "VERSION"), "utf8").trim();

// Every merge to main adds a release on top, so shipped releases are found by name, never by position.
function shippedRelease(releases, name) {
	const release = releases.find((entry) => entry.name === name);
	assert.ok(release, `CHANGELOG.md has a ${name} release`);
	return release;
}

const sectionTitles = (release) => release.sections.map((section) => section.title);

test("parses the shipped changelog into releases, sections and items", () => {
	const releases = parseChangelog(markdown);
	assert.equal(releases[0].name, "Unreleased");
	assert.equal(releases[0].date, null);
	const versions = releases.slice(1).map((release) => release.name);
	for (let index = 1; index < versions.length; index++) {
		assert.ok(
			compareVersions(versions[index - 1], versions[index]) > 0,
			`${versions[index - 1]} is listed above the older ${versions[index]}`,
		);
	}
	for (const release of releases.slice(1)) {
		assert.equal(release.date, release.name.split(".").slice(0, 3).join("-"), `${release.name} is dated its own day`);
	}
	// Unreleased gains headings with every pull request, so only their order is pinned.
	const keepAChangelogOrder = ["Changes", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
	const unreleasedTitles = sectionTitles(releases[0]);
	assert.deepEqual(
		unreleasedTitles,
		keepAChangelogOrder.filter((title) => unreleasedTitles.includes(title)),
	);
	const shipped = {
		"2026.10.22.0": ["Changes", "Added", "Changed", "Fixed", "Security"],
		"2026.10.13.0": ["Changes", "Fixed"],
		"2026.10.12.1": ["Changes", "Added", "Changed"],
		"2026.10.12.0": ["Changes", "Added", "Changed", "Fixed"],
		"2026.10.09.1": ["Changes", "Added", "Changed", "Fixed", "Security"],
		"2026.10.09.0": ["Changes", "Added", "Changed", "Security", "Fixed"],
	};
	for (const [name, titles] of Object.entries(shipped)) {
		assert.deepEqual(sectionTitles(shippedRelease(releases, name)), titles, name);
	}
});

test("a note above the first ### heading keeps its own section", () => {
	const september = shippedRelease(parseChangelog(markdown), "2026.10.09.1");
	assert.equal(september.sections[0].title, "Changes");
	assert.match(september.sections[0].items[0], /^No database migrations\./);
});

/** Releases whose first line under the heading is a paragraph rather than a `###` heading or a bullet. */
function releasesOpeningWithParagraph(text) {
	return text
		.split(/^## /m)
		.slice(1)
		.filter((block) => {
			const opening = block
				.split("\n")
				.slice(1)
				.find((line) => line.trim());
			return opening !== undefined && !/^###\s/.test(opening) && !/^\s*[-*]\s+\S/.test(opening);
		}).length;
}

test("every bullet in the file reaches the dialog", () => {
	const bullets = markdown.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
	const items = parseChangelog(markdown).flatMap((release) => release.sections.flatMap((section) => section.items));
	// A release that opens with a one-line paragraph adds one item for it.
	assert.ok(releasesOpeningWithParagraph(markdown) >= 6);
	assert.equal(items.length, bullets + releasesOpeningWithParagraph(markdown));
	for (const item of items) assert.ok(item.trim().length > 0);
});

test("wrapped bullets, deeper headings and unhandled lines are kept as content", () => {
	const releases = parseChangelog(
		[
			"# Changelog",
			"",
			"Preamble that belongs to no release.",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"- First item",
			"  wrapped onto the next line",
			"- Second item",
			"",
			"> a quoted note",
			"---",
			"#### Subsection",
			"",
			"## 2026.01.01.0 - 2026-01-01",
			"- bare bullet",
		].join("\n"),
	);
	assert.deepEqual(releases, [
		{
			name: "Unreleased",
			date: null,
			sections: [{ title: "Added", items: ["First item wrapped onto the next line", "Second item", "Subsection"] }],
		},
		{ name: "2026.01.01.0", date: "2026-01-01", sections: [{ title: "Changes", items: ["bare bullet"] }] },
	]);
});

test("a release that opens with an indented line still gets a section", () => {
	const [release] = parseChangelog("## [Unreleased]\n\n  indented opening\n");
	assert.deepEqual(release.sections, [{ title: "Changes", items: ["indented opening"] }]);
});

test("markdown without release headings has nothing to show", () => {
	assert.deepEqual(parseChangelog(""), []);
	assert.deepEqual(parseChangelog("# Changelog\n\nNotes about the project.\n"), []);
});

test("the newest release heading is titled for the dialog", () => {
	const releases = parseChangelog(markdown);
	assert.equal(changelogReleaseLabel(releases[0]), "Unreleased changes");
	// The newest release under Unreleased is the one VERSION names.
	assert.equal(changelogReleaseLabel(releases[1]), currentVersion);
});

test("inline markdown becomes text, code, strong and http links", () => {
	assert.deepEqual(parseInlineMarkdown("plain text"), [{ type: "text", text: "plain text" }]);
	assert.deepEqual(parseInlineMarkdown("run `npm run check` now"), [
		{ type: "text", text: "run " },
		{ type: "code", text: "npm run check" },
		{ type: "text", text: " now" },
	]);
	assert.deepEqual(parseInlineMarkdown("**Added** a feature"), [
		{ type: "strong", text: "Added" },
		{ type: "text", text: " a feature" },
	]);
	assert.deepEqual(parseInlineMarkdown("see [Deployment](https://example.com/x#y)"), [
		{ type: "text", text: "see " },
		{ type: "link", text: "Deployment", href: "https://example.com/x#y" },
	]);
	assert.deepEqual(parseInlineMarkdown("open [Settings → Inbox](/settings/inbox#notifications)"), [
		{ type: "text", text: "open " },
		{ type: "link", text: "Settings → Inbox", href: "/settings/inbox#notifications" },
	]);
	assert.equal(isAppChangelogHref("/settings/inbox"), true);
	assert.equal(isAppChangelogHref("https://example.com/settings"), false);
	assert.deepEqual(parseInlineMarkdown("`only code`"), [{ type: "code", text: "only code" }]);
	assert.deepEqual(parseInlineMarkdown(""), []);
});

test("HTML and unsafe links stay literal text", () => {
	assert.deepEqual(parseInlineMarkdown("<b>bold</b>"), [{ type: "text", text: "<b>bold</b>" }]);
	assert.deepEqual(parseInlineMarkdown("**unclosed"), [{ type: "text", text: "**unclosed" }]);
	// A repository-relative link means nothing in the rendered app, so it stays text.
	assert.deepEqual(parseInlineMarkdown("[Deployment](docs/deployment.md)"), [
		{ type: "text", text: "[Deployment](docs/deployment.md)" },
	]);
	// A protocol-relative URL would leave the app while looking like an app path.
	assert.deepEqual(parseInlineMarkdown("[x](//evil.example/settings)"), [
		{ type: "text", text: "[x](//evil.example/settings)" },
	]);
	assert.equal(isAppChangelogHref("//evil.example"), false);
	// Browsers treat a backslash as a slash, so these would leave the app too.
	assert.deepEqual(parseInlineMarkdown("[x](/\\evil.example/settings)"), [
		{ type: "text", text: "[x](/\\evil.example/settings)" },
	]);
	assert.equal(isAppChangelogHref("/\\evil.example"), false);
	assert.equal(isAppChangelogHref("/settings\\..\\\\evil.example"), false);
	assert.equal(isAppChangelogHref("/settings/inbox"), true);
	const unsafe = parseInlineMarkdown("[click](javascript:alert('x'))");
	assert.equal(unsafe.map((token) => token.text).join(""), "[click](javascript:alert('x'))");
	assert.ok(unsafe.every((token) => token.type === "text"));
});

test("the changelog only uses markup the dialog renders", () => {
	for (const release of parseChangelog(markdown)) {
		for (const section of release.sections) {
			for (const item of section.items) {
				assert.ok(item.length > 0);
				assert.ok(!item.includes("\n"));
			}
		}
	}
});
