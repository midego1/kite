import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-dialog-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/finance/dialog-utils.ts")],
	outfile: join(outDir, "dialog-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { parseAmountInput, trackForm, documentForm, documentBody, trackBody, linkHost } = await import(
	pathToFileURL(join(outDir, "dialog-utils.mjs")).href
);

const draft = {
	vendor: "Acmeflix",
	vendorKey: "acmeflix.example",
	plan: "Premium",
	amountMinor: 1799,
	currency: "USD",
	cycle: "monthly",
	nextRenewalOn: "2026-11-03",
	renewalEstimated: false,
	trialEndsOn: null,
	cancelLink: { url: "https://acmeflix.example/cancel", oneClick: true },
	document: {
		docType: "invoice",
		amountMinor: 1799,
		currency: "USD",
		documentOn: "2026-10-14",
		periodStartOn: null,
		periodEndOn: null,
		attachmentId: "att-1",
	},
	subscriptionId: null,
};

test("typed amounts read in the currency's minor digits and refuse anything ambiguous", () => {
	assert.equal(parseAmountInput("17.99", "USD"), 1799);
	assert.equal(parseAmountInput(" 17,5 ", "eur"), 1750);
	assert.equal(parseAmountInput("17", "USD"), 1700);
	assert.equal(parseAmountInput("1500", "JPY"), 1500);
	assert.equal(parseAmountInput("1.234", "BHD"), 1234);
	for (const text of ["", "0", "0.00", "-3", "1,000.00", "17.999", "15.5", "abc", "1e3"])
		assert.equal(parseAmountInput(text, text === "15.5" ? "JPY" : "USD"), null, text);
});

test("the forms start from the draft, or empty with today's date for a document", () => {
	assert.deepEqual(trackForm(draft), {
		vendor: "Acmeflix",
		plan: "Premium",
		amount: "17.99",
		currency: "USD",
		cycle: "monthly",
		nextRenewalOn: "2026-11-03",
		trialEndsOn: "",
		reminderDays: "3",
		calendarReminder: true,
	});
	assert.deepEqual(trackForm(null), {
		vendor: "",
		plan: "",
		amount: "",
		currency: "",
		cycle: "",
		nextRenewalOn: "",
		trialEndsOn: "",
		reminderDays: "3",
		calendarReminder: true,
	});
	assert.deepEqual(documentForm(draft.document, "2026-10-20"), {
		docType: "invoice",
		amount: "17.99",
		currency: "USD",
		documentOn: "2026-10-14",
		periodStartOn: "",
		periodEndOn: "",
		attachmentId: "att-1",
	});
	assert.deepEqual(documentForm(null, "2026-10-20"), {
		docType: "payment",
		amount: "",
		currency: "",
		documentOn: "2026-10-20",
		periodStartOn: "",
		periodEndOn: "",
		attachmentId: "",
	});
});

test("a document body carries minor units and nulls, or the first problem", () => {
	const form = documentForm(draft.document, "2026-10-20");
	assert.deepEqual(documentBody({ ...form, currency: "usd", periodStartOn: "2026-10-01", periodEndOn: "2026-10-31" }), {
		body: {
			docType: "invoice",
			amountMinor: 1799,
			currency: "USD",
			documentOn: "2026-10-14",
			periodStartOn: "2026-10-01",
			periodEndOn: "2026-10-31",
			attachmentId: "att-1",
		},
	});
	assert.equal(documentBody({ ...form, attachmentId: "" }).body.attachmentId, null);
	assert.match(documentBody({ ...form, currency: "€" }).error, /currency/);
	assert.match(documentBody({ ...form, amount: "x" }).error, /amount/);
	assert.match(documentBody({ ...form, documentOn: "" }).error, /date/);
	assert.match(documentBody({ ...form, periodStartOn: "2026-10-01" }).error, /period/);
});

test("the track body names the message, the document when recorded, and nulls for empty fields", () => {
	const form = trackForm(draft);
	const document = documentForm(draft.document, "2026-10-20");
	const built = trackBody(form, "msg-1", document);
	assert.deepEqual(built.body, {
		vendor: "Acmeflix",
		plan: "Premium",
		amountMinor: 1799,
		currency: "USD",
		cycle: "monthly",
		nextRenewalOn: "2026-11-03",
		trialEndsOn: null,
		reminderDays: 3,
		calendarReminder: true,
		messageId: "msg-1",
		document: documentBody(document).body,
	});
	const bare = trackBody({ ...trackForm(null), vendor: " Gym " }, "msg-1", null).body;
	assert.deepEqual(
		[bare.vendor, bare.plan, bare.amountMinor, bare.currency, bare.cycle, bare.document],
		["Gym", null, null, null, null, null],
	);
	assert.match(trackBody({ ...form, vendor: " " }, "msg-1", null).error, /vendor/);
	assert.match(trackBody({ ...form, currency: "" }, "msg-1", null).error, /currency/);
	assert.match(trackBody({ ...form, amount: "1,000.00" }, "msg-1", null).error, /amount/);
	assert.match(trackBody({ ...form, reminderDays: "31" }, "msg-1", null).error, /0 and 30/);
	assert.match(trackBody(form, "msg-1", { ...document, amount: "" }).error, /amount/);
});

test("the cancel link is named by its host", () => {
	assert.equal(linkHost("https://acmeflix.example/cancel?u=1"), "acmeflix.example");
	assert.equal(linkHost("not a url"), "not a url");
});
