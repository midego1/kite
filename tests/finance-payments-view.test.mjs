import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-payments-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/finance/payments-utils.ts")],
	outfile: join(outDir, "payments-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const view = await import(pathToFileURL(join(outDir, "payments-utils.mjs")).href);

function item(overrides = {}) {
	return {
		id: "fpay_1",
		source: "payment",
		docType: "payment",
		status: "paid",
		storedStatus: "paid",
		paired: false,
		vendor: "Kestrel Atlas",
		amount: { minor: 50_000, currency: "USD" },
		documentOn: "2026-11-02",
		subscriptionId: null,
		messageId: "m1",
		message: { kind: "mail:message", id: "m1", href: "/inbox/m1", label: "Your receipt" },
		modelFields: [],
		sender: "stripe.com",
		origin: "auto",
		...overrides,
	};
}

const ITEMS = [
	item(),
	item({
		id: "inv",
		docType: "invoice",
		status: "open",
		storedStatus: "open",
		vendor: "Hosting Co",
		amount: { minor: 12_000, currency: "EUR" },
		documentOn: "2026-11-01",
	}),
	item({
		id: "ref",
		docType: "refund",
		status: "refunded",
		storedStatus: "refunded",
		vendor: "Shop",
		amount: { minor: 3_500, currency: "EUR" },
		documentOn: "2026-10-12",
	}),
	item({
		id: "sub",
		source: "subscription",
		subscriptionId: "fsub_1",
		vendor: "Acmeflix",
		amount: { minor: 1_799, currency: "USD" },
		documentOn: "2026-10-01",
	}),
	item({
		id: "paired",
		docType: "invoice",
		status: "paid",
		storedStatus: "open",
		paired: true,
		vendor: "Shop",
		amount: { minor: 900, currency: "EUR" },
		documentOn: "2026-10-02",
	}),
	item({
		id: "fail",
		source: "subscription",
		docType: "failed_payment",
		status: "failed",
		storedStatus: "failed",
		amount: null,
		vendor: "Acmeflix",
		documentOn: "2026-10-03",
	}),
];

test("month totals of the shown rows stay per currency, with refunds and open invoices apart", () => {
	assert.deepEqual(view.monthTotals(ITEMS), [
		{ month: "2026-11", currency: "EUR", paidMinor: 0, refundedMinor: 0, openMinor: 12_000 },
		{ month: "2026-11", currency: "USD", paidMinor: 50_000, refundedMinor: 0, openMinor: 0 },
		{ month: "2026-10", currency: "EUR", paidMinor: 0, refundedMinor: 3_500, openMinor: 0 },
		{ month: "2026-10", currency: "USD", paidMinor: 1_799, refundedMinor: 0, openMinor: 0 },
	]);
	assert.deepEqual(
		view.totalsByMonth(view.monthTotals(ITEMS)).map((month) => [month.month, month.lines.length]),
		[
			["2026-11", 2],
			["2026-10", 2],
		],
	);
});

test("filters by vendor, month and status, and offer the vendors and months there are", () => {
	assert.deepEqual(view.filterOptions(ITEMS), {
		vendors: ["Acmeflix", "Hosting Co", "Kestrel Atlas", "Shop"],
		months: ["2026-11", "2026-10"],
	});
	const ids = (filters) =>
		view.filterPayments(ITEMS, { vendor: "", month: "", status: "", ...filters }).map((row) => row.id);
	assert.deepEqual(ids({ vendor: "Shop" }), ["ref", "paired"]);
	assert.deepEqual(ids({ month: "2026-11" }), ["fpay_1", "inv"]);
	assert.deepEqual(ids({ status: "paid" }), ["fpay_1", "sub", "paired"]);
	assert.deepEqual(ids({ status: "failed", vendor: "Acmeflix" }), ["fail"]);
});

test("amounts, months, days and the mail link", () => {
	assert.equal(view.amountText(item(), "en-US"), "$500.00");
	assert.equal(view.amountText(ITEMS[2], "en-US"), "−€35.00");
	assert.equal(view.amountText(ITEMS[5], "en-US"), null);
	assert.equal(view.monthLabel("2026-11", "en-US"), "November 2026");
	assert.equal(view.monthLabel("bad", "en-US"), "bad");
	assert.equal(view.dayLabel("2026-11-02", "en-US"), "Nov 2, 2026");
	assert.equal(view.dayLabel("bad", "en-US"), "bad");
	assert.equal(view.mailHref(item()), "/inbox/m1");
	assert.equal(
		view.mailHref(item({ message: { kind: "mail:message", id: "m1", unavailable: true, label: "x" } })),
		null,
	);
	assert.equal(
		view.mailHref(item({ message: { kind: "mail:message", id: "m1", href: "https://evil.example/", label: "x" } })),
		null,
	);
	assert.equal(view.mailHref(item({ message: null })), null);
	assert.equal(view.editable(item()), true);
	assert.equal(view.editable(ITEMS[3]), false);
});

test("a correction sends only what changed, and refuses what cannot be saved", () => {
	const invoice = ITEMS[1];
	const form = view.formFromPayment(invoice);
	assert.deepEqual(form, {
		vendor: "Hosting Co",
		amount: "120.00",
		currency: "EUR",
		documentOn: "2026-11-01",
		docType: "invoice",
		status: "open",
	});
	assert.deepEqual(view.correctionBody(form, invoice), { fields: {} });
	assert.deepEqual(view.correctionBody({ ...form, status: "paid", amount: "119,50" }, invoice), {
		fields: { amountMinor: 11_950, status: "paid" },
	});
	assert.deepEqual(view.correctionBody({ ...form, docType: "payment", vendor: " Host " }, invoice), {
		fields: { vendor: "Host", docType: "payment" },
	});
	assert.ok("error" in view.correctionBody({ ...form, currency: "EU" }, invoice));
	assert.ok("error" in view.correctionBody({ ...form, amount: "0" }, invoice));
	assert.ok("error" in view.correctionBody({ ...form, vendor: " " }, invoice));
	assert.ok("error" in view.correctionBody({ ...form, documentOn: "" }, invoice));
	assert.equal(view.formFromPayment(item({ amount: { minor: 1500, currency: "JPY" } })).amount, "1500");
	assert.equal(view.formFromPayment(ITEMS[5]).docType, "payment");
});
