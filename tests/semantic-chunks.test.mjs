import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// import.meta.resolve (plain strings in bundleModules's export list are invisible to it) lets knip see this test
// uses chunk-utils.ts, so its granular exports below are not reported as dead code.
void import.meta.resolve("../src/lib/semantic/chunk-utils.ts");

const {
	buildEmbeddingHeader,
	embeddingBodyText,
	chunkEmbeddingBody,
	buildEmbeddingText,
	isSemanticEligibleMessage,
	CHUNK_CHARS,
	CHUNK_OVERLAP,
	MAX_CHUNKS,
} = await bundleModules("kite-semantic-chunks-", [
	[
		"buildEmbeddingHeader, embeddingBodyText, chunkEmbeddingBody, buildEmbeddingText, isSemanticEligibleMessage, CHUNK_CHARS, CHUNK_OVERLAP, MAX_CHUNKS",
		"src/lib/semantic/chunk-utils.ts",
	],
]);

const base = {
	subject: "Offerte dakwerk",
	fromAddr: "contractor@example.nl",
	toAddr: "a@example.com, b@example.com, c@example.com, d@example.com",
	createdAt: new Date("2026-01-02T00:00:00Z"),
	attachmentNames: ["quote.pdf"],
};

test("the header names subject, from, the first three recipients, an ISO date and attachment file names", () => {
	const header = buildEmbeddingHeader(base);
	assert.match(header, /^Subject: Offerte dakwerk/);
	assert.match(header, /From: contractor@example\.nl/);
	assert.match(header, /To: a@example\.com, b@example\.com, c@example\.com$/m);
	assert.doesNotMatch(header, /d@example\.com/);
	assert.match(header, /Date: 2026-01-02/);
	assert.match(header, /Attachments: quote\.pdf/);
});

test("a message without a subject or attachments has no such line", () => {
	const header = buildEmbeddingHeader({ ...base, subject: null, attachmentNames: [] });
	assert.doesNotMatch(header, /Subject:/);
	assert.doesNotMatch(header, /Attachments:/);
});

test("quoted replies are removed: a `>` quote and an `On ... wrote:` line both cut the body there", () => {
	const quoted = embeddingBodyText({
		textBody:
			"Thanks, that works for me.\n\nOn Tue, Jan 1, 2026 at 9:00 AM, Sam <sam@example.com> wrote:\n> Old content\n> more old content",
		htmlBody: null,
	});
	assert.equal(quoted, "Thanks, that works for me.");

	const bareQuote = embeddingBodyText({ textBody: "My reply.\n> quoted line one\n> quoted line two", htmlBody: null });
	assert.equal(bareQuote, "My reply.");
});

test("HTML is converted to readable text when there is no plain-text part", () => {
	const text = embeddingBodyText({ textBody: null, htmlBody: "<p>Hello <b>there</b></p><p>Second line</p>" });
	assert.equal(text, "Hello there \n Second line");
});

test("whitespace is collapsed: runs of blank lines fold to one, runs of spaces/tabs fold to one", () => {
	const text = embeddingBodyText({ textBody: "Line one\n\n\n\n\nLine   two\t\tthree", htmlBody: null });
	assert.equal(text, "Line one\n\nLine two three");
});

test("short text is one chunk with no splitting", () => {
	const chunks = chunkEmbeddingBody("Hi there, short note.");
	assert.deepEqual(chunks, ["Hi there, short note."]);
});

test("long text is split at paragraph boundaries into chunks of about CHUNK_CHARS, each with CHUNK_OVERLAP carried over", () => {
	const paragraph = (marker) =>
		`Paragraph ${marker} begins here with a unique marker PM${marker}END. ` +
		"Filler text to pad this paragraph out to roughly two hundred characters long so chunking logic has real work to do today.";
	const text = Array.from({ length: 20 }, (_, index) => paragraph(index)).join("\n\n");
	assert.ok(text.length > CHUNK_CHARS * 2);
	const chunks = chunkEmbeddingBody(text);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.ok(chunk.length <= CHUNK_CHARS + CHUNK_OVERLAP + 200);
	// Consecutive chunks share the tail of the previous one at their start.
	for (let index = 0; index < chunks.length - 1; index++) {
		const tail = chunks[index].slice(-CHUNK_OVERLAP);
		assert.ok(chunks[index + 1].includes(tail.slice(0, 50)), `chunk ${index} -> ${index + 1} should overlap`);
	}
	// Markers appear across chunks in increasing order, confirming forward progress through the text.
	const markersOf = (chunk) => [...chunk.matchAll(/PM(\d+)END/g)].map((match) => Number(match[1]));
	const firstMarkers = chunks.map((chunk) => markersOf(chunk)[0]);
	assert.deepEqual(
		firstMarkers,
		[...firstMarkers].sort((a, b) => a - b),
	);
});

test("a message is never split into more than MAX_CHUNKS chunks, however long", () => {
	const huge = Array.from({ length: 200 }, (_, index) => `Paragraph ${index}. `.repeat(50)).join("\n\n");
	const chunks = chunkEmbeddingBody(huge);
	assert.ok(chunks.length <= MAX_CHUNKS);
});

test("a single run-on paragraph longer than one chunk is still split (sentence, then hard, boundaries)", () => {
	const sentence = "This sentence has no paragraph break at all so it must be split some other way. ";
	const text = sentence.repeat(60);
	const chunks = chunkEmbeddingBody(text);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.ok(chunk.length <= CHUNK_CHARS + CHUNK_OVERLAP + 10);
});

test("buildEmbeddingText repeats the header at the top of every chunk", () => {
	const longText = Array.from({ length: 20 }, (_, index) => `Paragraph ${index}. `.repeat(20)).join("\n\n");
	const chunks = buildEmbeddingText({ ...base, textBody: longText });
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.match(chunk, /^Subject: Offerte dakwerk/);
});

test("eligibility: received, sent and archived mail not judged spam only", () => {
	assert.equal(isSemanticEligibleMessage({ status: "received", spamVerdict: null }), true);
	assert.equal(isSemanticEligibleMessage({ status: "sent", spamVerdict: "inbox" }), true);
	assert.equal(isSemanticEligibleMessage({ status: "archived" }), true);
	assert.equal(isSemanticEligibleMessage({ status: "received", spamVerdict: "spam" }), false);
	for (const status of ["draft", "spam", "trash", "screening", "template", "queued", "failed"])
		assert.equal(isSemanticEligibleMessage({ status }), false, status);
});
