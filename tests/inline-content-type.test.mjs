import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-content-type-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/http/content-type-utils.ts")],
	outfile: join(bundleDirectory, "content-type.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { getDownloadContentType, getInlineContentType } = await import(
	pathToFileURL(join(bundleDirectory, "content-type.mjs")).href
);

test("inline types are served as their bare essence, text keeps its charset", () => {
	assert.equal(getInlineContentType("image/PNG"), "image/png");
	assert.equal(getInlineContentType('image/jpeg; name="photo.jpg"'), "image/jpeg");
	assert.equal(getInlineContentType("application/pdf"), "application/pdf");
	assert.equal(getInlineContentType("video/mp4"), "video/mp4");
	assert.equal(getInlineContentType("audio/mpeg"), "audio/mpeg");
	assert.equal(
		getInlineContentType('text/plain; charset="ISO-8859-1"; format=flowed'),
		"text/plain; charset=ISO-8859-1",
	);
	assert.equal(getInlineContentType("text/csv"), "text/csv");
	assert.equal(getInlineContentType("application/json"), "application/json");
});

test("active or unparsable types never render inline", () => {
	for (const type of [
		"text/html",
		"TEXT/HTML; charset=utf-8",
		"image/svg+xml",
		"image/svg+xml;charset=utf-8",
		"image/svg+xml ; charset=utf-8",
		"application/xml",
		"text/xml",
		"application/xhtml+xml",
		"application/javascript",
		"image/png, text/html",
		"image/png; x=1, text/html",
		'text/plain; charset="a,b"',
		"image/png\ttext/html",
		"multipart/related",
		"image/tiff",
		"",
		null,
		undefined,
	]) {
		assert.equal(getInlineContentType(type), null, String(type));
	}
});

test("downloads keep a clean essence or fall back to opaque bytes", () => {
	assert.equal(getDownloadContentType("image/svg+xml;charset=utf-8"), "image/svg+xml");
	assert.equal(getDownloadContentType(" Text/HTML "), "text/html");
	assert.equal(getDownloadContentType("not a type"), "application/octet-stream");
	assert.equal(getDownloadContentType("TEXT/HTML; charset=utf-8"), "text/html");
	assert.equal(getDownloadContentType("image/png, text/html"), "application/octet-stream");
	assert.equal(getDownloadContentType(null), "application/octet-stream");
});
