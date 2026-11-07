import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PostalMime from "postal-mime";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The preflight is a model of how postal-mime reads a message, so these hold it against postal-mime itself: its own
// tree of parts, reached through the parser instance, says how many parts there are and what is decoded as text. A
// postal-mime upgrade that reads anything differently fails here before it can reopen a memory bomb.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-mime-preflight-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { MIME_LIMITS, mimePreflightCounts } from "./src/lib/email/mime-preflight.ts";`,
		resolveDir: root,
		sourcefile: "mime-preflight-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { MIME_LIMITS, mimePreflightCounts } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const LINE_FEED = 10;
const CALENDAR_TYPES = ["text/calendar", "application/ics"];

/** What postal-mime does with `raw`, under the options `parseRawMime` gives it. */
async function parserReading(raw) {
	const parser = new PostalMime({
		maxNestingDepth: MIME_LIMITS.maxNestingDepth,
		maxHeadersSize: MIME_LIMITS.maxTotalHeaderBytes,
		maxPartCount: MIME_LIMITS.maxParts,
		forceRfc822Attachments: true,
	});
	try {
		await parser.parse(raw);
	} catch (error) {
		return { error: error.code ?? String(error) };
	}
	let textParts = 0;
	let lineFeeds = 0;
	const walk = (node) => {
		const isText = parser.isInlineTextNode(node) || CALENDAR_TYPES.includes(node.contentType.parsed.value);
		if (!node.contentType.multipart && isText) {
			textParts++;
			for (const byte of new Uint8Array(node.content ?? new ArrayBuffer(0))) if (byte === LINE_FEED) lineFeeds++;
		}
		for (const child of node.childNodes) walk(child);
	};
	walk(parser.root);
	return { parts: parser.counters.partCount, textParts, lineFeeds };
}

/** Holds one message against the parser: same parts, and every decoded line feed counted (one spare per text part). */
async function assertModels(rawText, label) {
	const raw = new Uint8Array(Buffer.from(rawText, "latin1"));
	const counts = mimePreflightCounts(raw);
	const parsed = await parserReading(raw);
	if (parsed.error) {
		assert.ok(counts.reason, `${label}: the parser stopped with ${parsed.error}, the preflight let it through`);
		return null;
	}
	if (counts.reason) return null;
	assert.equal(counts.parts, parsed.parts, `${label}: part count`);
	assert.ok(counts.textLines >= parsed.lineFeeds, `${label}: ${counts.textLines} < ${parsed.lineFeeds} decoded lines`);
	assert.ok(
		counts.textLines <= parsed.lineFeeds + parsed.textParts,
		`${label}: ${counts.textLines} counted for ${parsed.lineFeeds} decoded lines in ${parsed.textParts} text parts`,
	);
	return { counts, parsed };
}

const message = (headers, body) => `From: a@b.example\r\n${headers.join("\r\n")}\r\n\r\n${body}`;
const ten = "x\r\n".repeat(10);
const plainPart = (boundary) => `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${ten}`;
const attachmentPart = (boundary) =>
	`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment\r\n\r\n${ten}`;

// One case per line of postal-mime's changelog the preflight has to follow, each decided by how many text lines it sees.
const CASES = {
	"an ordinary text body": message(["Content-Type: text/plain"], ten),
	"no Content-Type at all": message([], ten),
	"a non-field line ends the header block": `From: a@b.example\r\nNot a field\r\nContent-Type: application/pdf\r\n\r\n${ten}`,
	"a non-field line ends a part's header block": message(
		['Content-Type: multipart/mixed; boundary="b"'],
		`--b\r\nSome text\r\nContent-Disposition: attachment\r\n\r\n${ten}--b--\r\n`,
	),
	"a line with a byte order mark is no field": `From: a@b.example\r\nï»¿Content-Type: application/pdf\r\n\r\n${ten}`,
	"a line with an invalid byte is no field": `From: a@b.example\r\nXé: 1\r\nContent-Type: application/pdf\r\n\r\n${ten}`,
	"whitespace before the colon names another field": message(
		["Content-Type : application/pdf", "Content-Type: text/plain"],
		ten,
	),
	"a whitespace-only line folds": message(["Content-Type: text/plain", "   ", "X-A: 1"], ten),
	"the first Content-Type wins": message(["Content-Type: text/plain", "Content-Type: application/pdf"], ten),
	"the first Content-Disposition wins": message(
		["Content-Type: text/plain", "Content-Disposition: inline", "Content-Disposition: attachment"],
		ten,
	),
	"a disposition type ends at whitespace": message(
		["Content-Type: text/plain", "Content-Disposition: attachment garbage"],
		ten,
	),
	"a Content-Type with junk is no text": message(["Content-Type: text/plain garbage"], ten),
	"an attached text file is no text": message(["Content-Type: text/plain", "Content-Disposition: attachment"], ten),
	"a calendar attachment is decoded as text": message(
		["Content-Type: text/calendar", "Content-Disposition: attachment"],
		ten,
	),
	"application/ics is decoded as text": message(["Content-Type: application/ics"], ten),
	"the outermost boundary matches first": message(
		['Content-Type: multipart/mixed; boundary="b"'],
		`--b\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${ten}--b--\r\n${ten}`,
	),
	"a terminator of the outer boundary reads as the inner one's prefix": message(
		['Content-Type: multipart/mixed; boundary="b--"'],
		`--b--\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${ten}--b----\r\n`,
	),
	"a closed boundary no longer matches": message(
		['Content-Type: multipart/mixed; boundary="o"'],
		`--o\r\nContent-Type: multipart/alternative; boundary="b"\r\n\r\n--b\r\n\r\nhi\r\n--b--\r\n--o\r\nContent-Type: text/plain\r\n\r\n--b\r\n${ten}--o--\r\n`,
	),
	"trailing whitespace in a boundary parameter": message(
		['Content-Type: multipart/mixed; boundary="b "'],
		`${plainPart("b")}--b--\r\n`,
	),
	"a boundary holding a non-ASCII byte reads as text": message(
		['Content-Type: multipart/mixed; boundary="bé"'],
		`--bé\r\nContent-Type: application/pdf\r\n\r\n${ten}`,
	),
	"a multipart without a boundary reads as text": message(["Content-Type: multipart/mixed"], ten),
	"an empty multipart subtype is no multipart": message(
		['Content-Type: multipart/; boundary="b"'],
		`--b\r\nContent-Type: text/plain\r\n\r\n${ten}--b--\r\n`,
	),
	"a part of a digest defaults to message/rfc822": message(
		['Content-Type: multipart/digest; boundary="d"'],
		`--d\r\n\r\nFrom: p@list.example\r\n\r\n${ten}--d--\r\n`,
	),
	"preamble and epilogue are no text": message(
		['Content-Type: multipart/mixed; boundary="b"'],
		`preamble\r\n${attachmentPart("b")}--b--\r\n${ten}`,
	),
	"a comment hides a parameter": message(
		['Content-Type: multipart/mixed (comment; boundary="x"); boundary="b"'],
		`${plainPart("b")}--b--\r\n`,
	),
	"a value behind a closed quote is junk": message(
		['Content-Type: multipart/mixed; boundary="b" "; x=1"'],
		`${plainPart("b")}--b--\r\n`,
	),
	"carriage returns before the line feed": message(
		['Content-Type: multipart/mixed; boundary="b"'],
		`--b\r\nContent-Type: application/pdf\r\n\r\nQUFB\r\n--b\r\r\nContent-Type: text/plain\r\n\r\n${ten}--b--\r\n`,
	),
	"x-base64 is no base64": message(["Content-Type: text/plain", "Content-Transfer-Encoding: x-base64"], ten),
	"a quoted encoding token is none": message(["Content-Type: text/plain", 'Content-Transfer-Encoding: "base64"'], ten),
	"the first transfer encoding wins": message(
		["Content-Type: text/plain", "Content-Transfer-Encoding: 7bit", "Content-Transfer-Encoding: base64"],
		ten,
	),
	"a comment before the transfer encoding": message(
		["Content-Type: text/plain", "Content-Transfer-Encoding: (c) base64"],
		`${Buffer.from("a\r\nb\r\nc\r\n").toString("base64")}\r\n`,
	),
	"a base64 text body counts decoded": message(
		["Content-Type: text/plain", "Content-Transfer-Encoding: base64"],
		`${Buffer.from("a\r\n".repeat(50))
			.toString("base64")
			.replace(/(.{76})/g, "$1\r\n")}\r\n`,
	),
	"padding realigns base64 groups": message(
		["Content-Type: text/plain", "Content-Transfer-Encoding: base64"],
		`CgoK\r\nQQ==\r\nCg==\r\nCgo=\r\n`,
	),
	"a quoted-printable body counts its escapes": message(
		["Content-Type: text/plain", "Content-Transfer-Encoding: quoted-printable"],
		`${"=0D=0a".repeat(30)}\r\n`,
	),
	"a base64 message/rfc822 part is no text": message(
		['Content-Type: multipart/mixed; boundary="b"'],
		`--b\r\nContent-Type: message/rfc822\r\nContent-Transfer-Encoding: base64\r\n\r\nQUFB\r\n--b--\r\n`,
	),
};

for (const [name, raw] of Object.entries(CASES)) {
	test(`preflight models postal-mime: ${name}`, async () => {
		assert.ok(await assertModels(raw, name), `${name} was refused`);
	});
}

/** Small deterministic generator, so a failure names a seed that reproduces it. */
function random(seed) {
	let state = seed >>> 0 || 1;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 2 ** 32;
	};
	return {
		pick: (list) => list[Math.floor(next() * list.length)],
		chance: (odds) => next() < odds,
		int: (max) => Math.floor(next() * max),
	};
}

const BOUNDARIES = ["b", "c", "bc", "b-", "b--"];
const TYPES = [
	"text/plain",
	"text/html",
	"TEXT/PLAIN; charset=utf-8",
	"text/plain; format=flowed; delsp=yes",
	"text/html garbage",
	"text/calendar; method=REQUEST",
	"application/ics",
	"text/csv",
	"application/pdf",
	"message/rfc822",
	"",
	"multipart/mixed",
	"multipart/; boundary=@",
	"multipart/mixed; boundary=@",
	'multipart/alternative; boundary="@"',
	'multipart/related; boundary="@ "',
	"multipart/digest; boundary=@",
	'multipart/mixed (a; boundary=z); boundary="@"',
	"multipart/mixed; x=1; flag; boundary=@",
	'multipart/mixed; boundary="@" "; x=y"',
	"multipart/mixed; boundary=@é",
	'multipart/mixed;\r\n\tboundary="@"',
	'multipart/mixed; x="(y"; boundary=@',
	"multipart/mixed; boundary=(@",
];
const ENCODINGS = [
	"7bit",
	"8bit",
	"binary",
	"base64",
	"BASE64",
	"x-base64",
	"(c) base64",
	"base64 (c)",
	"base64 x",
	'"base64"',
	"quoted-printable",
	"Quoted-Printable",
];
const DISPOSITIONS = [
	"attachment",
	"inline",
	"attachment garbage",
	"ATTACHMENT; filename=a.txt",
	"attachment\tx",
	"form-data",
];
const NOISE = [
	"X-A: 1",
	" folded on to what is above",
	"\tfolded",
	"   ",
	"Not a field",
	"From me",
	"Content-Type : application/pdf",
	"ï»¿Content-Type: application/pdf",
	"Xé: 1",
	"X-CafÃ©: 1",
	": no name",
];
const BODY_LINES = ["text", "", " ", "From x", "QUFB", "Cgo=", "CgoK", "=0D=0A", "=0a", "a=0Ab", "--", "---", "--x"];

function generateHeaders(rng) {
	const lines = [];
	const add = (name, values) => lines.push(`${name}: ${rng.pick(values).replaceAll("@", rng.pick(BOUNDARIES))}`);
	const fields = rng.int(5);
	for (let index = 0; index < fields; index++) {
		if (rng.chance(0.5)) add(rng.pick(["Content-Type", "content-type", "CONTENT-TYPE"]), TYPES);
		if (rng.chance(0.3)) add("Content-Transfer-Encoding", ENCODINGS);
		if (rng.chance(0.2)) add("Content-Disposition", DISPOSITIONS);
		if (rng.chance(0.3)) lines.push(rng.pick(NOISE));
	}
	return lines;
}

/** Most delimiters name a boundary the message declared, or nothing would open a part. */
function generateDelimiter(rng, lines) {
	const declared = lines.flatMap((line) => [...line.matchAll(/boundary="?([\w-]+)/g)].map((match) => match[1]));
	const boundary = declared.length && rng.chance(0.85) ? rng.pick(declared) : rng.pick(BOUNDARIES);
	return `--${boundary}${rng.pick(["", "", "", "", "--", "  ", "--\t", "x"])}`;
}

function generateMessage(seed) {
	const rng = random(seed);
	const eol = rng.pick(["\r\n", "\r\n", "\n", "\r\r\n"]);
	const lines = rng.chance(0.7) ? ["Content-Type: multipart/mixed; boundary=b"] : [];
	lines.push(...generateHeaders(rng));
	const sections = 1 + rng.int(8);
	for (let section = 0; section < sections; section++) {
		lines.push("");
		const count = rng.int(6);
		for (let index = 0; index < count; index++) lines.push(rng.pick(BODY_LINES));
		lines.push(generateDelimiter(rng, lines), ...generateHeaders(rng));
	}
	if (rng.chance(0.7)) lines.push("");
	return lines.join(eol).replaceAll("\r\n\t", `${eol}\t`) + (rng.chance(0.8) ? eol : "");
}

test("preflight models postal-mime on generated messages", async () => {
	let modelled = 0;
	let withParts = 0;
	let withText = 0;
	for (let seed = 1; seed <= 4000; seed++) {
		const result = await assertModels(generateMessage(seed), `seed ${seed}`);
		if (!result) continue;
		modelled++;
		if (result.parsed.parts > 2) withParts++;
		if (result.parsed.lineFeeds > 2) withText++;
	}
	// The generator has to reach what it is for: most messages parsed, many of them multipart and with text.
	assert.ok(modelled > 3000, `${modelled} messages modelled`);
	assert.ok(withParts > 500, `${withParts} multipart messages`);
	assert.ok(withText > 500, `${withText} messages with text`);
});

test("preflight stops at the limits postal-mime stops at", async () => {
	const multipart = (boundary) => `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
	const parts = `From: a@b.example\r\n${multipart("b")}${"--b\r\n\r\n".repeat(MIME_LIMITS.maxParts)}`;
	assert.match(mimePreflightCounts(new TextEncoder().encode(parts)).reason, /too many MIME parts/);
	assert.equal((await parserReading(new TextEncoder().encode(parts))).error, "EMAXPARTCOUNT");
	const fits = `From: a@b.example\r\n${multipart("b")}${"--b\r\n\r\n".repeat(MIME_LIMITS.maxParts - 1)}`;
	assert.equal(mimePreflightCounts(new TextEncoder().encode(fits)).reason, null);
	assert.equal((await parserReading(new TextEncoder().encode(fits))).parts, MIME_LIMITS.maxParts);

	const nest = (depth) =>
		"From: a@b.example\r\n" +
		Array.from({ length: depth }, (_, level) => `${multipart(`l${level}`)}--l${level}\r\n`).join("") +
		"Content-Type: text/plain\r\n\r\nx\r\n";
	const deep = new TextEncoder().encode(nest(MIME_LIMITS.maxNestingDepth + 1));
	assert.match(mimePreflightCounts(deep).reason, /nesting depth/);
	assert.equal((await parserReading(deep)).error, "EMAXNESTINGDEPTH");
	const nested = new TextEncoder().encode(nest(MIME_LIMITS.maxNestingDepth));
	assert.equal(mimePreflightCounts(nested).reason, null);
	assert.ok((await parserReading(nested)).parts);

	const textLines = (count) => `From: a@b.example\r\n\r\n${"x\r\n".repeat(count)}`;
	const atLimit = new TextEncoder().encode(textLines(MIME_LIMITS.maxTextLines));
	assert.equal(mimePreflightCounts(atLimit).reason, null);
	const overLimit = new TextEncoder().encode(textLines(MIME_LIMITS.maxTextLines + 1));
	assert.match(mimePreflightCounts(overLimit).reason, /too many lines/);

	// Header bytes add up across the message, a line counting for at least 64 bytes, as postal-mime counts them.
	// Each block here stays under the per-block limit, so only the 2 MiB total is at fault.
	const block = `--b\r\n${"X-A: 1\r\n".repeat(600)}\r\n`;
	const headers = new TextEncoder().encode(`From: a@b.example\r\n${multipart("b")}${block.repeat(70)}`);
	assert.match(mimePreflightCounts(headers).reason, /2 MiB in total/);
	assert.doesNotMatch(mimePreflightCounts(headers).reason, /64 KiB/);
	assert.equal((await parserReading(headers)).error, "EMAXHEADERSIZE");

	// One block over 64 KiB names that limit, not the 2 MiB total it never reaches.
	const oneBigBlock = new TextEncoder().encode(
		`From: a@b.example\r\nX-A: ${"a".repeat(MIME_LIMITS.maxHeaderBytes)}\r\n\r\n`,
	);
	assert.match(mimePreflightCounts(oneBigBlock).reason, /64 KiB/);
});
