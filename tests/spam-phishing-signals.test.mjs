import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-spam-phishing-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		engine: fileURLToPath(import.meta.resolve("../src/lib/spam/engine.ts")),
		tokenizer: fileURLToPath(import.meta.resolve("../src/lib/spam/tokenizer.ts")),
		db: fileURLToPath(import.meta.resolve("../src/db/index.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { analyzeSpam } = await load("engine");
const { buildFingerprint, prepareSpamContent } = await load("tokenizer");
const { createDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const file = (filename, type, text, extra = {}) => ({
	filename,
	type,
	content: new TextEncoder().encode(text).buffer,
	disposition: "attachment",
	contentId: null,
	...extra,
});

function email(overrides = {}) {
	return {
		subject: "Hello",
		text: "Just checking in.",
		html: null,
		messageId: "<m1@example.test>",
		fromAddr: "Sender <sender@example.test>",
		toAddr: "owner@example.com",
		ccAddr: null,
		bccAddr: null,
		inReplyTo: null,
		references: [],
		date: null,
		attachments: [],
		...overrides,
	};
}

async function setup(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
	`);
	const db = createDb(sqlite);
	const seen = [];
	const analyze = (message) =>
		analyzeSpam(db, {
			mailboxId: "mailbox-a",
			userId: "owner",
			envelopeFrom: "bounce@example.test",
			message,
			intelligenceProvider: { check: async (input) => (seen.push(input), []) },
		});
	return { sqlite, analyze, seen };
}

const ids = (result) => result.signals.map((signal) => signal.id);
const signal = (result, id) => result.signals.find((item) => item.id === id);

// Invented data, shaped like a fake invoice: a no-reply sender, an HTML "invoice" and a whitelist request.
const fakeInvoicePage = `<html><body><script>var u = atob("aHR0cHM6Ly9sb2dpbi54bi0tZXhtcGxlLTl0YS50ZXN0Lw=="); window.location.href = u;</script>
<a href="https://xn--exmple-9ta.test/login">Open</a></body></html>`;
const fakeInvoice = email({
	subject: "Invoice 19/1234 of 4/09/26 - 7001234 GMBH",
	fromAddr: "Accountancy <no-reply@billing-example.test>",
	text: [
		"Dear customer,",
		"Please find attached our invoice with reference 19/1234.",
		"Have you received this mail in your Junk or Spam folder? Mark this mail as 'safe' and add our domain name to your whitelist.",
	].join("\n"),
	attachments: [file("1234_2026_7001234.html", "text/html", fakeInvoicePage)],
});

test("a fake invoice with an attached web page is flagged as a phishing lure", async (t) => {
	const { analyze, seen } = await setup(t);
	const result = await analyze(fakeInvoice);
	assert.ok(ids(result).includes("html_attachment"));
	assert.deepEqual(signal(result, "html_attachment").metadata, { count: 1, lure: true, decoy: false });
	assert.equal(signal(result, "html_attachment").score, 25);
	assert.ok(ids(result).includes("attachment_active_content"));
	assert.ok(ids(result).includes("safelist_pressure"));
	assert.ok(ids(result).includes("punycode_url"), "a link inside the attachment is checked too");
	assert.notEqual(result.verdict, "inbox");
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0].urls, []);
	assert.deepEqual(seen[0].attachmentUrls, ["https://xn--exmple-9ta.test/login"]);
	assert.equal(seen[0].attachments.length, 1);
});

test("attached web pages: login forms, SVG files and decoy names; inline images and PDFs are not", async (t) => {
	const { analyze } = await setup(t);
	const form = await analyze(
		email({
			attachments: [
				file("secure-message.htm", "application/octet-stream", '<form><input type="password" name="p"></form>'),
			],
		}),
	);
	assert.ok(ids(form).includes("attachment_login_form"));
	assert.equal(signal(form, "html_attachment").score, 15, "no invoice wording, no decoy name");
	const svg = await analyze(email({ attachments: [file("scan.svg", "image/svg+xml", "<svg></svg>")] }));
	assert.ok(ids(svg).includes("html_attachment"));
	const decoy = await analyze(email({ attachments: [file("report.pdf.html", "text/html", "<p>hi</p>")] }));
	assert.deepEqual(signal(decoy, "html_attachment").metadata, { count: 1, lure: true, decoy: true });
	const refresh = await analyze(
		email({
			attachments: [file("x.html", "text/html", '<meta http-equiv="refresh" content="0;url=https://elsewhere.test/">')],
		}),
	);
	assert.ok(ids(refresh).includes("attachment_active_content"));
	const inline = await analyze(
		email({
			html: '<p>Logo <img src="cid:logo"></p>',
			attachments: [file("logo.svg", "image/svg+xml", "<svg></svg>", { disposition: "inline", contentId: "logo" })],
		}),
	);
	assert.equal(ids(inline).includes("html_attachment"), false);
	const pdf = await analyze(email({ attachments: [file("invoice.pdf", "application/pdf", "%PDF-1.4")] }));
	assert.deepEqual(
		ids(pdf).filter((id) => id.includes("attachment")),
		[],
	);
});

test("programs and disk images are risky attachments", async (t) => {
	const { analyze } = await setup(t);
	for (const name of ["setup.exe", "update.hta", "run.ps1", "photo.lnk", "disk.iso"]) {
		const result = await analyze(email({ attachments: [file(name, "application/octet-stream", "x")] }));
		assert.ok(ids(result).includes("risky_attachment"), name);
	}
	const notes = await analyze(email({ attachments: [file("notes.txt", "text/plain", "x")] }));
	assert.equal(ids(notes).includes("risky_attachment"), false);
});

test("whitelist requests count, a newsletter's address book request does not", async (t) => {
	const { analyze } = await setup(t);
	for (const text of [
		"Please add our domain to your whitelist.",
		"Select 'never block mails from this domain name'.",
		"Mark this e-mail as not spam.",
		"Found this in your spam folder? Please move it to your inbox.",
	]) {
		const result = await analyze(email({ text }));
		assert.ok(ids(result).includes("safelist_pressure"), text);
	}
	const newsletter = await analyze(
		email({ text: "Add us to your address book so our weekly digest reaches you. Unsubscribe any time." }),
	);
	assert.equal(ids(newsletter).includes("safelist_pressure"), false);
});

test("links inside attachments stay out of the fingerprint, so feedback on the stored message matches", () => {
	const stored = { ...fakeInvoice, attachments: [] };
	assert.equal(buildFingerprint(fakeInvoice), buildFingerprint(stored));
	const prepared = prepareSpamContent(fakeInvoice);
	assert.deepEqual(prepared.urlDomains, []);
	assert.deepEqual(prepared.attachmentUrlDomains, ["xn--exmple-9ta.test"]);
});
