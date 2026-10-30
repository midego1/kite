import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	FONT_ASSETS,
	fontAsset,
	readerFontStyles,
	APPEARANCE_PREFERENCES,
	EMAIL_FONT_PREFERENCE,
	FONT_PREFERENCE,
	appearanceBootstrapScript,
	isDyslexiaFont,
	parseLayoutPatch,
	layoutStorageEntries,
	buildEmailFrameDocument,
} = await bundleModules("kite-appearance-font-", [
	["FONT_ASSETS, fontAsset, readerFontStyles", "src/components/font-assets-utils.ts"],
	[
		"APPEARANCE_PREFERENCES, EMAIL_FONT_PREFERENCE, FONT_PREFERENCE, appearanceBootstrapScript, isDyslexiaFont",
		"src/components/appearance-preferences.ts",
	],
	["parseLayoutPatch", "src/lib/preferences/layout-utils.ts"],
	["layoutStorageEntries", "src/components/layout-preferences-utils.ts"],
	["buildEmailFrameDocument", "src/components/messages/email-html-frame-utils.ts"],
]);

test("the dyslexia-friendly font is a Font option with its faces, files and licence in the repository", async () => {
	const globals = await readFile(join(root, "src/app/globals.css"), "utf8");
	for (const [value, asset] of Object.entries(FONT_ASSETS)) {
		assert.ok(isDyslexiaFont(value), `${value} is a dyslexia-friendly Font value`);
		assert.ok(
			FONT_PREFERENCE.options.some((option) => option.value === value),
			`${value} is offered in the Font setting`,
		);
		assert.equal(fontAsset(value), asset);
		const folder = join(root, "public", asset.stylesheet.slice(1, asset.stylesheet.lastIndexOf("/")));
		const css = await readFile(join(root, "public", asset.stylesheet), "utf8");
		assert.match(css, new RegExp(`font-family:"${asset.family}"`));
		assert.match(css, /font-display:swap/);
		const files = [...css.matchAll(/url\(([^)]+)\)/g)].map((file) => file[1]);
		assert.equal(files.length, 4, "regular, bold and both italics");
		for (const file of files) await readFile(join(folder, file));
		await readFile(join(root, "public", asset.preload));
		assert.match(await readFile(join(folder, "LICENSE.txt"), "utf8"), /SIL Open Font License, Version 1\.1/);
		// The app stylesheet declares the same faces, so a page that has the font chosen paints in it at once.
		const faces = [...globals.matchAll(/@font-face\s*\{([^}]*)\}/g)]
			.map((face) => face[1])
			.filter((face) => face.includes(`"${asset.family}"`));
		assert.equal(faces.length, 4);
		for (const face of faces) {
			assert.match(face, /font-display:\s*swap/);
			const url = face.match(/url\("([^"]+)"\)/)[1];
			assert.ok(files.includes(url.slice(url.lastIndexOf("/") + 1)), `${url} is one of the stylesheet's files`);
			await readFile(join(root, "public", url));
		}
	}
	assert.equal(fontAsset("manrope"), undefined);
	assert.equal(fontAsset(null), undefined);
	assert.equal(fontAsset("constructor"), undefined);
	assert.equal(isDyslexiaFont("auto"), false);
});

test("the layout sync accepts exactly the Font and HTML email font values", () => {
	for (const { value } of FONT_PREFERENCE.options)
		assert.deepEqual(parseLayoutPatch({ layout: { font: value } }), { font: value }, `${value} is accepted`);
	for (const { value } of EMAIL_FONT_PREFERENCE.options)
		assert.deepEqual(parseLayoutPatch({ layout: { emailFont: value } }), { emailFont: value });
	assert.equal(FONT_PREFERENCE.layoutKey, "font");
	assert.equal(EMAIL_FONT_PREFERENCE.layoutKey, "emailFont");
	assert.deepEqual(parseLayoutPatch({ layout: { font: "opendyslexic", emailFont: "reader" } }), {
		font: "opendyslexic",
		emailFont: "reader",
	});
	assert.deepEqual(parseLayoutPatch({ layout: { font: "comic-sans", emailFont: "maybe" } }), null);
	assert.deepEqual(layoutStorageEntries({ font: "opendyslexic", emailFont: "original" }, "user"), [
		["kite-font", "opendyslexic"],
		["kite-email-font", "original"],
	]);
	assert.ok(APPEARANCE_PREFERENCES.includes(EMAIL_FONT_PREFERENCE));
});

test("the bootstrap script sets the attribute and preloads only a chosen dyslexia-friendly font", () => {
	function boot(saved) {
		const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
			runScripts: "outside-only",
			url: "https://kite.test/",
		});
		for (const [key, value] of Object.entries(saved)) dom.window.localStorage.setItem(key, value);
		dom.window.eval(appearanceBootstrapScript);
		return dom.window.document;
	}
	const off = boot({ "kite-font": "manrope", "kite-text-size": "large" });
	assert.equal(off.documentElement.getAttribute("data-font"), "manrope");
	assert.equal(off.documentElement.getAttribute("data-text-size"), "large");
	assert.equal(off.head.querySelectorAll("link").length, 0);

	const on = boot({ "kite-font": "opendyslexic", "kite-email-font": "reader" });
	assert.equal(on.documentElement.getAttribute("data-font"), "opendyslexic");
	assert.equal(on.documentElement.getAttribute("data-email-font"), "reader");
	const links = [...on.head.querySelectorAll("link")].map((link) => [
		link.getAttribute("rel"),
		link.getAttribute("as"),
		link.getAttribute("href"),
		link.getAttribute("crossorigin"),
		link.getAttribute("data-kite-font"),
	]);
	// Only the regular weight is preloaded; bold and the italics load on first use (font-display: swap).
	assert.deepEqual(links, [["preload", "font", FONT_ASSETS.opendyslexic.preload, "anonymous", "opendyslexic"]]);

	const none = boot({});
	assert.equal(none.documentElement.hasAttribute("data-font"), false);
	assert.equal(none.head.querySelectorAll("link").length, 0);
});

test("the reader frame replaces the mail's fonts only when asked, keeping code monospace", () => {
	const html = '<p style="color:red">Hello</p><pre>code</pre>';
	const plain = buildEmailFrameDocument(html);
	assert.doesNotMatch(plain, /OpenDyslexic|fonts\//);

	const styled = buildEmailFrameDocument(html, { font: FONT_ASSETS.opendyslexic });
	assert.match(styled, /<link rel="stylesheet" href="\/fonts\/opendyslexic\/opendyslexic.css">/);
	assert.match(styled, /body \*\{font-family:"OpenDyslexic",sans-serif!important/);
	assert.match(styled, /pre,code[^}]*monospace!important/);
	assert.ok(styled.indexOf("<link") < styled.indexOf("<body>"), "the font is linked in the head");
	// The frame never edits the sanitized markup; inline font families are the sanitizer's job (dropFontFamily).
	assert.ok(styled.includes(html), styled);
});
