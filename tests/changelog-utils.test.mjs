import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
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
const { changelogReleaseLabel, parseChangelog, parseInlineMarkdown } = await import(
	pathToFileURL(join(bundleDirectory, "changelog.mjs")).href
);

const markdown = readFileSync(join(root, "CHANGELOG.md"), "utf8");

test("parses the shipped changelog into releases, sections and items", () => {
	const releases = parseChangelog(markdown);
	assert.deepEqual(
		releases.map((release) => release.name),
		["Unreleased", "2026.10.12.0", "2026.10.09.1", "2026.10.09.0"],
	);
	assert.equal(releases[0].date, null);
	assert.equal(releases[1].date, "2026-10-12");
	assert.deepEqual(
		releases[0].sections.map((section) => section.title),
		["Added"],
	);
	assert.deepEqual(
		releases[1].sections.map((section) => section.title),
		["Changes", "Added", "Changed", "Fixed"],
	);
	assert.deepEqual(
		releases[3].sections.map((section) => section.title),
		["Changes", "Added", "Changed", "Security", "Fixed"],
	);
});

test("a note above the first ### heading keeps its own section", () => {
	const september = parseChangelog(markdown)[2];
	assert.equal(september.name, "2026.10.09.1");
	assert.equal(september.sections[0].title, "Changes");
	assert.match(september.sections[0].items[0], /^No database migrations\./);
});

test("every bullet in the file reaches the dialog", () => {
	const bullets = markdown.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
	const items = parseChangelog(markdown).flatMap((release) => release.sections.flatMap((section) => section.items));
	// The three releases that open with a paragraph add one item each.
	assert.equal(items.length, bullets + 3);
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
	assert.equal(changelogReleaseLabel(releases[1]), "2026.10.12.0");
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
