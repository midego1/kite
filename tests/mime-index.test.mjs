import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PostalMime from "postal-mime";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { FIXTURES, base64, largeFixture, pseudoRandomBytes } from "./fixtures/mime/fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-mime-index-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export {
				indexMimeParts,
				decodePart,
				decodedPartLength,
				createBase64DecodeStream,
				matchAttachmentsToParts,
				mimeParameter,
				MIME_INDEX_MAX_PARTS,
			} from "./src/lib/email/mime-index-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "mime-index-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const encoder = new TextEncoder();

/** postal-mime with the options `parseRawMime` uses (`src/lib/email/parse.ts`). */
async function postalAttachments(raw) {
	const email = await PostalMime.parse(raw, { maxNestingDepth: 20, forceRfc822Attachments: true });
	return email.attachments.map((attachment) => ({
		...attachment,
		content:
			typeof attachment.content === "string" ? encoder.encode(attachment.content) : new Uint8Array(attachment.content),
	}));
}

function rangeOf(raw, part) {
	return raw.subarray(part.bodyOffset, part.bodyOffset + part.bodyLength);
}

for (const fixture of FIXTURES) {
	test(`index: ${fixture.name}`, async (t) => {
		const raw = encoder.encode(fixture.raw);
		const attachments = await postalAttachments(raw);
		assert.equal(attachments.length, fixture.expected.length, "postal-mime attachment count");
		const parts = m.indexMimeParts(raw);
		const { matches, unmatched } = m.matchAttachmentsToParts(raw, attachments, parts);
		assert.equal(matches.length + unmatched.length, attachments.length);
		for (const match of matches) {
			// Never matched wrongly: the range alone, decoded again, is exactly postal-mime's bytes.
			const decoded = m.decodePart(rangeOf(raw, match.part), match.part.transferEncoding);
			assert.deepEqual(decoded, attachments[match.attachmentIndex].content);
		}
		fixture.expected.forEach((expectation, index) => {
			if (expectation === "match") assert.ok(!unmatched.includes(index), `attachment ${index} should match`);
			if (expectation === "unmatched") assert.ok(unmatched.includes(index), `attachment ${index} should not match`);
			if (expectation === "either")
				t.diagnostic(`attachment ${index}: ${unmatched.includes(index) ? "unmatched" : "matched"}`);
		});
		const usedParts = new Set(matches.map((match) => match.part));
		assert.equal(usedParts.size, matches.length, "a part is used once");
	});
}

test("index: part metadata reads names, dispositions, content ids and folded headers", () => {
	const nested = FIXTURES.find((fixture) => fixture.name.startsWith("related inside"));
	const parts = m.indexMimeParts(encoder.encode(nested.raw));
	assert.deepEqual(
		parts.map((part) => [part.contentType, part.disposition, part.filename, part.contentId, part.transferEncoding]),
		[
			["text/plain", null, null, null, "identity"],
			["text/html", null, null, null, "identity"],
			["image/png", "inline", "logo.png", "<logo@example.com>", "base64"],
			["application/pdf", "attachment", "report.pdf", null, "base64"],
		],
	);
	const folded = m.indexMimeParts(encoder.encode(FIXTURES.find((fixture) => fixture.name.startsWith("folded")).raw));
	assert.equal(folded[1].filename, "report.pdf");
	assert.equal(folded[1].transferEncoding, "base64");
	const encodings = m.indexMimeParts(
		encoder.encode(FIXTURES.find((fixture) => fixture.name.startsWith("quoted-printable")).raw),
	);
	assert.deepEqual(
		encodings.map((part) => part.transferEncoding),
		["identity", null, null],
	);
});

test("index: the line break before a delimiter belongs to the delimiter", () => {
	const raw = encoder.encode(
		[
			"Content-Type: multipart/mixed; boundary=b",
			"",
			"--b",
			"Content-Type: text/plain",
			"",
			"abc",
			"--b",
			"Content-Type: text/plain",
			"",
			"--b--",
		].join("\r\n"),
	);
	const parts = m.indexMimeParts(raw);
	assert.equal(new TextDecoder().decode(rangeOf(raw, parts[0])), "abc");
	assert.equal(parts[1].bodyLength, 0);
});

test("index: a boundary that is only a prefix of a line is not a delimiter", () => {
	const raw = encoder.encode(
		["Content-Type: multipart/mixed; boundary=b", "", "--b", "", "--bx", "--b ", "", "next", "--b--"].join("\n"),
	);
	const parts = m.indexMimeParts(raw);
	assert.equal(parts.length, 2);
	assert.equal(new TextDecoder().decode(rangeOf(raw, parts[0])), "--bx");
	assert.equal(new TextDecoder().decode(rangeOf(raw, parts[1])), "next");
});

test("index: stops at the part cap", () => {
	const many = Array.from({ length: m.MIME_INDEX_MAX_PARTS + 20 }, (_, index) => `--b\n\npart ${index}`);
	const raw = encoder.encode(["Content-Type: multipart/mixed; boundary=b", "", ...many, "--b--"].join("\n"));
	assert.equal(m.indexMimeParts(raw).length, m.MIME_INDEX_MAX_PARTS);
});

test("index: RFC 2231 parameters, continuations and charsets", () => {
	assert.equal(m.mimeParameter([["filename*", "utf-8''r%C3%A9sum%C3%A9.pdf"]], "filename"), "résumé.pdf");
	assert.equal(
		m.mimeParameter(
			[
				["boundary*1", "-two"],
				["boundary*0", "one"],
			],
			"boundary",
		),
		"one-two",
	);
	assert.equal(
		m.mimeParameter(
			[
				["name", "plain.txt"],
				["name*", "utf-8''other.txt"],
			],
			"name",
		),
		"plain.txt",
	);
	assert.equal(m.mimeParameter([], "name"), null);
	const raw = encoder.encode(
		[
			"Content-Type: multipart/mixed; boundary*0=split; boundary*1=-boundary",
			"",
			"--split-boundary",
			"Content-Transfer-Encoding: base64",
			"",
			base64(pseudoRandomBytes(90, 5)),
			"--split-boundary--",
		].join("\r\n"),
	);
	const [part] = m.indexMimeParts(raw);
	assert.deepEqual(m.decodePart(rangeOf(raw, part), "base64"), pseudoRandomBytes(90, 5));
});

test("decode: base64 tails, padding and junk are read the same way as mail clients do", () => {
	for (let length = 0; length < 20; length++) {
		const bytes = pseudoRandomBytes(length, length + 1);
		const encoded = encoder.encode(base64(bytes, { width: 7, trailing: " \t" }));
		assert.deepEqual(m.decodePart(encoded, "base64"), bytes);
		assert.equal(m.decodedPartLength(encoded, "base64"), length);
	}
	const identity = encoder.encode("as is\r\n");
	assert.equal(m.decodePart(identity, "identity"), identity);
	assert.equal(m.decodedPartLength(identity, "identity"), identity.length);
});

async function decodeStreamed(encoded, cuts) {
	const chunks = [];
	let start = 0;
	for (const cut of [...cuts, encoded.length]) {
		chunks.push(encoded.subarray(start, cut));
		start = cut;
	}
	const source = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const output = await new Response(source.pipeThrough(m.createBase64DecodeStream())).arrayBuffer();
	return new Uint8Array(output);
}

test("decode: streaming equals batch for 200 random chunkings", async () => {
	let seed = 99;
	const random = (limit) => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed % limit;
	};
	for (let round = 0; round < 200; round++) {
		const bytes = pseudoRandomBytes(1 + random(4000), round + 1);
		const encoded = encoder.encode(
			base64(bytes, { width: [0, 64, 72, 76][round % 4], eol: round % 3 ? "\r\n" : "\n" }),
		);
		const cuts = Array.from({ length: random(12) }, () => random(encoded.length + 1)).sort((a, b) => a - b);
		const streamed = await decodeStreamed(encoded, cuts);
		assert.deepEqual(streamed, m.decodePart(encoded, "base64"), `round ${round}`);
		assert.deepEqual(streamed, bytes, `round ${round}`);
	}
});

test("index and verify a 24 MiB message", async (t) => {
	const { raw: text, bytes } = largeFixture(24 * 1024 * 1024);
	const raw = encoder.encode(text);
	const started = performance.now();
	const parts = m.indexMimeParts(raw);
	const { matches, unmatched } = m.matchAttachmentsToParts(raw, [{ content: bytes }], parts);
	const elapsed = performance.now() - started;
	assert.equal(matches.length, 1);
	assert.deepEqual(unmatched, []);
	assert.ok(raw.length > 23 * 1024 * 1024, `raw is ${raw.length} bytes`);
	// The spec's target is 100 ms; the bound here leaves room for slow, shared CI runners. Coverage instrumentation
	// slows the byte loops twenty-fold, so the coverage run only checks the result.
	const instrumented =
		Boolean(process.env.NODE_V8_COVERAGE) || process.execArgv.includes("--experimental-test-coverage");
	if (!instrumented) assert.ok(elapsed < 2_000, `index and verify took ${Math.round(elapsed)} ms`);
	t.diagnostic(`24 MiB index and verify: ${Math.round(elapsed)} ms`);
});
