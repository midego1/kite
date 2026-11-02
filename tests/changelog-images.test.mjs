import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
	absoluteImageUrls,
	IMAGE_DIRECTORY,
	imageProblems,
	markdownImages,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_WIDTH,
	webpDimensions,
} from "../scripts/changelog-images.mjs";
import { fragmentProblems, readFragments } from "../scripts/changelog-fragments.mjs";
import { renderPublishedNotes } from "../scripts/deploy/release-publish-utils.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "kite-changelog-images-"));
after(() => rmSync(temp, { recursive: true, force: true }));

/** A minimal lossy WebP header: RIFF, WEBP, "VP8 " chunk with the frame tag, start code and dimensions. */
function webp(width, height, padding = 0) {
	const body = Buffer.alloc(30 + padding);
	body.write("RIFF", 0, "latin1");
	body.writeUInt32LE(body.length - 8, 4);
	body.write("WEBPVP8 ", 8, "latin1");
	body.writeUInt32LE(body.length - 20, 16);
	body.set([0x9d, 0x01, 0x2a], 23);
	body.writeUInt16LE(width, 26);
	body.writeUInt16LE(height, 28);
	return body;
}

function project(files) {
	const directory = mkdtempSync(join(temp, "root-"));
	mkdirSync(join(directory, IMAGE_DIRECTORY), { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, IMAGE_DIRECTORY, name), content);
	return directory;
}

const fragment = (body, name = "shot.md") => ({ name, text: `### Added\n\n- A change.\n  ${body}\n` });

test("webpDimensions reads lossy, lossless and extended headers", () => {
	assert.deepEqual(webpDimensions(webp(1280, 720)), { width: 1280, height: 720 });
	const extended = Buffer.alloc(40);
	extended.write("RIFF", 0, "latin1");
	extended.write("WEBPVP8X", 8, "latin1");
	extended.writeUIntLE(1599, 24, 3);
	extended.writeUIntLE(799, 27, 3);
	assert.deepEqual(webpDimensions(extended), { width: 1600, height: 800 });
	const lossless = Buffer.alloc(40);
	lossless.write("RIFF", 0, "latin1");
	lossless.write("WEBPVP8L", 8, "latin1");
	lossless.writeUInt32LE(1023 | (511 << 14), 21);
	assert.deepEqual(webpDimensions(lossless), { width: 1024, height: 512 });
	assert.equal(webpDimensions(Buffer.from("not an image at all, just text, long enough to pass")), null);
});

test("images in code blocks and inline code are examples, not images", () => {
	const text =
		"- Real ![a](/changelog/a.webp)\n\n```\n![b](/changelog/b.webp)\n```\n\nUse `![c](/changelog/c.webp)`.\n";
	assert.deepEqual(markdownImages(text), [{ alt: "a", src: "/changelog/a.webp" }]);
});

test("a fragment image needs alt text, a /changelog/ WebP path and a file that fits the limits", () => {
	const directory = project({
		"ok.webp": webp(1200, 700),
		"wide.webp": webp(MAX_IMAGE_WIDTH + 1, 100),
		"heavy.webp": webp(800, 600, MAX_IMAGE_BYTES),
		"fake.webp": Buffer.from("this is not a webp file, only text that is long enough"),
	});
	const problems = (body) => fragmentProblems([fragment(body)], { root: directory });
	assert.deepEqual(problems("![Command center](/changelog/ok.webp)"), []);
	assert.match(problems("![](/changelog/ok.webp)").join("\n"), /no alt text/);
	assert.match(problems("![x](https://example.com/a.webp)").join("\n"), /no remote URLs/);
	assert.match(problems("![x](/changelog/a.png)").join("\n"), /must be \/changelog\/<name>\.webp/);
	assert.match(problems("![x](/changelog/../ok.webp)").join("\n"), /must be \/changelog\//);
	assert.match(problems("![x](/changelog/missing.webp)").join("\n"), /missing\.webp does not exist/);
	assert.match(problems("![x](/changelog/wide.webp)").join("\n"), /1601 px wide/);
	assert.match(problems("![x](/changelog/heavy.webp)").join("\n"), /KB, the limit is 200 KB/);
	assert.match(problems("![x](/changelog/fake.webp)").join("\n"), /not a WebP image/);
	// Without a root only the syntax is checked, so a unit test of a fragment needs no files.
	assert.deepEqual(fragmentProblems([fragment("![x](/changelog/missing.webp)")]), []);
});

test("every screenshot CHANGELOG.md and the fragments name exists and fits, and none is left unused", () => {
	const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	assert.deepEqual(imageProblems(changelog, "CHANGELOG.md", root), []);
	const fragments = readFragments(root);
	assert.deepEqual(fragmentProblems(fragments, { root }), []);
	const used = new Set(
		[changelog, ...fragments.map((entry) => entry.text)].flatMap((text) =>
			markdownImages(text).map((image) => image.src.replace("/changelog/", "")),
		),
	);
	const files = readdirSync(join(root, IMAGE_DIRECTORY));
	assert.ok(files.length > 0, "the backfilled releases have screenshots");
	for (const file of files) assert.ok(used.has(file), `${IMAGE_DIRECTORY}/${file} is not used by any release note`);
});

test("GitHub release notes point screenshots at the raw file in the repository", () => {
	const section = "### Added\n\n- A change.\n  ![Palette](/changelog/p.webp)\n- A [link](/settings/inbox) stays.";
	const rewritten = absoluteImageUrls(section);
	assert.match(
		rewritten,
		/!\[Palette\]\(https:\/\/raw\.githubusercontent\.com\/midego1\/kite\/main\/public\/changelog\/p\.webp\)/,
	);
	assert.match(rewritten, /\[link\]\(\/settings\/inbox\)/);
	const notes = renderPublishedNotes({
		version: "2026.11.02.0",
		changelog: `## [2026.11.02.0] - 2026-11-02\n\n${section}\n`,
		base: "v2026.11.01.5",
		subjects: [],
	});
	assert.ok(!notes.includes("(/changelog/"), "no relative screenshot path reaches GitHub");
	assert.ok(notes.includes("https://raw.githubusercontent.com/midego1/kite/main/public/changelog/p.webp"));
});
