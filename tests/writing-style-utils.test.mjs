import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-writing-style-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		utils: fileURLToPath(import.meta.resolve("../src/lib/agent/writing-style-utils.ts")),
		language: fileURLToPath(import.meta.resolve("../src/lib/agent/writing-style-language-utils.ts")),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const ws = await load("utils");
const { detectLanguage } = await load("language");

const measureHtml = (html) => ws.measureMessage(ws.ownText(html, null));
const measureText = (text) => ws.measureMessage(ws.ownText(null, text));

test("own text drops the quote, the signature block, a forwarded message and plain-text quotes", () => {
	const html =
		'<div>Hi Sam,</div><div><br></div><div>Thanks for the update.</div><div><br></div><div>Best,</div><div data-kite-signature="1"><br><br>Alex<br>+31 6 1234 5678</div><div class="kite-quote" data-kite-quote="1">On Monday Sam wrote: secret</div>';
	assert.deepEqual(ws.ownText(html, null), { text: "Hi Sam,\n\nThanks for the update.\n\nBest,", hasList: false });
	assert.equal(ws.ownText('<div>Hello</div><div data-mailflare-signature="1">Old</div>', null).text, "Hello");
	assert.equal(
		ws.ownText("<div>See below.</div><div>---------- Forwarded message ---------</div><div>x</div>", null).text,
		"See below.",
	);
	assert.deepEqual(ws.ownText(null, "Sure, see you then.\n\nOn Mon, 1 Jan 2026, Sam wrote:\n> hello\n> there"), {
		text: "Sure, see you then.",
		hasList: false,
	});
	assert.equal(ws.ownText(null, "Hello there\n-- \nAlex\nCEO").text, "Hello there");
	assert.equal(ws.ownText("<div>Points:</div><ul><li>One</li><li>Two</li></ul>", null).hasList, true);
});

test("each metric is measured, with greetings and sign-offs as anonymous forms", () => {
	const measured = measureHtml(
		"<div>Hi Sam,</div><div><br></div><div>Can you send the report today? It is due tomorrow! Thanks for checking 😀</div><div><br></div><div>Cheers,</div>",
	);
	assert.equal(measured.greeting, "hi {name},");
	assert.equal(measured.signOff, "cheers,");
	assert.deepEqual(measured.values, {
		words: 16,
		sentenceWords: 13 / 3,
		paragraphs: 1,
		questionShare: 1 / 3,
		exclamationRate: 100 / 16,
		emojiRate: 100 / 16,
		listUse: 0,
		greetingUse: 1,
		signOffUse: 1,
		formalAddress: null,
	});
	assert.equal(measured.language, null, "fewer than 20 words has no language");
});

test("languages are told apart, and formal address counts only where the language has it", () => {
	const nl = measureText(
		"Hoi Sam,\n\nDank je voor je bericht. Kun je mij morgen de cijfers sturen? Dan kijk ik er even naar en laat ik je weten wat ik ervan vind.\n\nGroet,",
	);
	assert.equal(nl.language, "nl");
	assert.equal(nl.values.formalAddress, 0);
	const formalNl = measureText(
		"Geachte heer Jansen,\n\nHartelijk dank voor uw bericht. Kunt u mij laten weten wanneer u de stukken kunt sturen? Dan neem ik het met mijn collega door en hoort u van ons.\n\nMet vriendelijke groet,",
	);
	assert.equal(formalNl.language, "nl");
	assert.equal(formalNl.values.formalAddress, 1);
	assert.equal(formalNl.greeting, "geachte heer {name},");
	assert.equal(formalNl.signOff, "met vriendelijke groet,");
	const de = measureText(
		"Hallo Frau Weber,\n\nSie haben recht. Ich schicke Ihnen die Unterlagen morgen, damit Sie sie vor dem Termin mit Ihrem Team in Ruhe ansehen können und wir dann alles besprechen.\n\nViele Grüße,",
	);
	assert.equal(de.language, "de");
	// "Sie" at the start of a sentence may mean "they"; only "Ihnen", "Sie" and "Ihrem" inside sentences count.
	assert.equal(de.values.formalAddress, 1);
	const fr = measureText(
		"Bonjour Marie,\n\nTu as raison, je te propose de faire le point demain. Est-ce que tu peux me dire si cette heure est bien pour toi et pour ton équipe aussi ?\n\nAmicalement,",
	);
	assert.equal(fr.language, "fr");
	assert.equal(fr.values.formalAddress, 0);
	const es = measureText(
		"Hola Carlos,\n\nGracias por su mensaje. Le envío los documentos que usted pidió para que los revise con su equipo antes de la reunión del lunes por la mañana.\n\nSaludos,",
	);
	assert.equal(es.language, "es");
	assert.equal(es.values.formalAddress, 1);
	const en = measureText(
		"Hello Sam,\n\nThank you for your message. I will send you the documents you asked for so that you can review them with your team before the meeting.\n\nBest regards,",
	);
	assert.equal(en.language, "en");
	assert.equal(en.values.formalAddress, null, "English has no formal address to measure");
	assert.equal(detectLanguage("one two three".split(" ")), null);
	const english =
		"I think we can send the report to you and the team this week if that would work for all of you".split(" ");
	assert.equal(detectLanguage(english), "en");
	assert.equal(detectLanguage(Array.from({ length: 25 }, (_, index) => `zorblax${index}`)), "other");
});

test("forms never keep a name, an address, a link or digits; short or huge messages are skipped", () => {
	assert.equal(ws.anonymiseForm("Dear Mr. Jones,", "dear"), "dear {name},");
	assert.equal(ws.anonymiseForm("Hi sam@example.com https://x.test 0612345678,", "hi"), "hi,");
	assert.equal(ws.anonymiseForm("Best, Sam Smith", "best"), "best, {name}");
	assert.equal(measureText("Thanks, see you."), null, "under five words");
	assert.equal(measureText("word ".repeat(4_001).trim()), null, "over 20,000 characters");
	const plain = measureText("Talk soon about the plan for next week then.\n\nTalk soon,");
	assert.equal(plain.signOff, "talk soon,");
	assert.equal(plain.greeting, null);
});

test("Welford's running mean and variance equal a two-pass computation up to 300 samples", () => {
	const values = Array.from({ length: 250 }, (_, index) => ((index * 37) % 101) / 7);
	let state;
	for (const value of values) state = ws.welfordStep(state, value);
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
	assert.equal(state.n, 250);
	assert.ok(Math.abs(state.mean - mean) < 1e-9);
	assert.ok(Math.abs(ws.welfordDeviation(state) - Math.sqrt(variance)) < 1e-9);
	assert.equal(ws.welfordDeviation({ n: 9, mean: 1, m2: 1 }), null, "no range below ten samples");
});

test("above the cap each new message weighs 1/300, so a change in style shows", () => {
	let state;
	for (let index = 0; index < 300; index++) state = ws.welfordStep(state, 10);
	for (let index = 0; index < 300; index++) state = ws.welfordStep(state, 100);
	assert.equal(state.n, 300);
	assert.ok(state.mean > 60, `the recent value dominates: ${state.mean}`);
});

test("top-K keeps eight forms and evicts the least frequent other one", () => {
	let counts = {};
	for (const [form, times] of Object.entries({ a: 5, b: 4, c: 3, d: 3, e: 2, f: 2, g: 2, h: 2 }))
		for (let index = 0; index < times; index++) counts = ws.bumpTopK(counts, form);
	counts = ws.bumpTopK(counts, "new");
	assert.equal(Object.keys(counts).length, 8);
	assert.equal(counts.new, 1);
	assert.equal(counts.h, undefined, "the least frequent (and last alphabetically) is evicted");
	assert.deepEqual(ws.bumpTopK(counts, null), counts);
});

function profileOf(messages, times = 1) {
	let profile = ws.emptyProfile();
	for (let round = 0; round < times; round++)
		for (const text of messages) profile = ws.updateProfile(profile, measureText(text));
	return profile;
}

const DUTCH = [
	"Hoi {first},\n\nDank je voor je bericht. Kun je mij morgen de cijfers sturen? Dan kijk ik er even naar en laat ik je weten wat ik ervan vind.\n\nGroet,",
	"Hoi {first},\n\nIk heb je voorstel gelezen en het ziet er goed uit. Laten we donderdag even bellen om de laatste punten door te nemen als jij dan kunt.\n\nGroet,",
];

test("the description is null under ten samples and names what the thresholds allow", () => {
	assert.equal(
		ws.describeWritingStyle(
			profileOf(
				DUTCH.map((text) => text.replace("{first}", "Sam")),
				4,
			),
		),
		null,
	);
	const profile = profileOf(
		DUTCH.map((text) => text.replace("{first}", "Sam")),
		6,
	);
	const description = ws.describeWritingStyle(profile);
	assert.match(
		description,
		/^Writes in Dutch\. Usually (?:about \d+|\d+ to \d+) words in one paragraph, with short sentences \(about \d+ words\)\./,
	);
	assert.match(description, /Opens with "hoi \{name\}," and closes with "groet,"\./);
	assert.match(description, /Addresses people informally \(je\)\./);
	assert.match(description, /Rarely uses exclamation marks; does not use emoji\./);
	assert.ok(
		description.endsWith(
			"Replace {name} with the recipient's first name, or leave the greeting out when you do not know it.",
		),
	);
	assert.ok(description.length <= ws.DESCRIPTION_MAX_CHARS);
	assert.doesNotMatch(ws.describeWritingStyle(profile, { withoutFormality: true }), /formally|informally/);
	assert.equal(ws.STYLE_THRESHOLDS.formShareOfForms, 0.3);
});

test("no form is named without enough use, and no {name} appears without the explanation", () => {
	const varied = profileOf(
		Array.from(
			{ length: 12 },
			(_, index) =>
				`Thanks for the quick reply number ${index}, I will look at the plan and the budget tomorrow and get back to you.`,
		),
	);
	const description = ws.describeWritingStyle(varied);
	assert.doesNotMatch(description, /Opens with|closes with|\{name\}/);
	assert.match(description, /^Writes in English\./);
	for (let count = 10; count < 40; count += 7) {
		const text = ws.describeWritingStyle(
			profileOf(
				DUTCH.map((value) => value.replace("{first}", "Sam")),
				count,
			),
		);
		assert.ok(text.length <= 500);
		assert.equal(text.includes("{name}"), text.includes("Replace {name}"));
	}
});

test("a long description is cut to 500 characters by dropping whole sentences, never mid-word", () => {
	const profile = profileOf(
		DUTCH.map((value) => value.replace("{first}", "Sam")),
		6,
	);
	profile.greetings = { [`hoi ${"x".repeat(200)} {name},`]: 12 };
	profile.signOffs = { [`groet ${"y".repeat(200)},`]: 12 };
	const description = ws.describeWritingStyle(profile);
	assert.ok(description.length <= 500, String(description.length));
	assert.ok(description.endsWith("."));
});
