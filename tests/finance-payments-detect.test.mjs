import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const detect = await loadFinance("detect-utils");
const payments = await loadFinance("payment-utils");
const list = await loadFinance("payment-list-utils");
const vendors = await loadFinance("vendor-utils");
const model = await loadFinance("model-utils");

const RECEIVED = "2026-11-03T10:00:00.000Z";

function stepInput({
	from = "receipts@shop.example",
	fromName = "Shop",
	subject = "Your receipt from Shop",
	body = "Amount paid: €42.00\nReceipt #R-1001",
	facts = {},
	attachments = [],
	model: modelAnswer = null,
} = {}) {
	return {
		message: { id: "m1", mailboxId: "mb1", from, fromName, subject, receivedAt: RECEIVED, textExcerpt: body },
		facts: {
			authPassed: true,
			bulk: false,
			knownContact: false,
			phishing: [],
			automatic: true,
			noReply: false,
			list: false,
			spam: false,
			muted: false,
			...facts,
		},
		headers: { listUnsubscribe: null, listUnsubscribePost: null, listId: null },
		attachments,
		model: modelAnswer,
	};
}

function run(options = {}) {
	const input = stepInput(options);
	const analysis = detect.analyzeMessage(input, "UTC");
	if (!analysis) return null;
	const extraction = model.parseModelExtraction(model.modelExtensionOf(input), {
		messageDay: analysis.dates.messageDay,
		paymentFailed: analysis.paymentFailed,
	});
	return payments.detectPayment(model.mergeDetection(analysis, extraction), analysis, input);
}

// A synthetic receipt of the shape the owner reported: a one-off charge a merchant takes through Stripe, sent from a
// receipts+acct_ address under Stripe's name. Every value is invented.
const STRIPE_RECEIPT = {
	from: "receipts+acct_1AbCdEfGhIjKlMn@stripe.com",
	fromName: "Stripe",
	subject: "Your Stripe Atlas receipt [#1114-6093]",
	body: [
		"Stripe Atlas",
		"Receipt #1114-6093",
		"",
		"Amount paid",
		"$500.00",
		"",
		"Date paid",
		"Nov 2, 2026",
		"",
		"Payment method",
		"Visa - 4242",
		"",
		"Summary",
		"Stripe Atlas signup fee   $500.00",
		"Amount charged   $500.00",
		"",
		"Questions? Contact us at help@atlas.invalid.",
	].join("\n"),
};

test("a one-off Stripe receipt lands as paid, USD 500.00, from the merchant, on the date paid", () => {
	assert.deepEqual(run(STRIPE_RECEIPT), {
		vendor: "Stripe Atlas",
		vendorKey: "stripe.com:stripe-atlas",
		docType: "payment",
		status: "paid",
		amountMinor: 50_000,
		currency: "USD",
		documentOn: "2026-11-02",
		attachmentId: null,
		modelFields: [],
	});
});

test("a processor receipt names the merchant from the subject or a Receipt from line, not the processor", () => {
	const name = (fromName, subject, body = null) =>
		vendors.messageVendor(fromName, "receipts+acct_1X@stripe.com", subject, body).vendor;
	assert.equal(name("Stripe", "Your receipt from Acme Tools #2214-0001"), "Acme Tools");
	assert.equal(name(null, "Your Acme Tools receipt [#2214-0001]"), "Acme Tools");
	assert.equal(name("Stripe", "Payment confirmation", "Receipt from Acme Tools\nAmount paid $9.00"), "Acme Tools");
	// A merchant that sends under its own name keeps it; a non-processor sender is unchanged.
	assert.equal(name("Acme Tools", "Your receipt from Other Co"), "Acme Tools");
	assert.equal(
		vendors.messageVendor("Shop", "billing@shop.example", "Your receipt from Other Co", null).vendor,
		"Shop",
	);
	// Nothing to read the merchant from: the processor's own name stays.
	assert.equal(name("Stripe", "Payment confirmation"), "Stripe");
	assert.equal(vendors.vendorKey("receipts+acct_1X@stripe.com", "Acme Tools"), "stripe.com:acme-tools");
});

test("invoices are open, receipts paid, refunds refunded and credit notes credited, in five languages", () => {
	const cases = [
		[
			{ subject: "Invoice INV-2041 from Hosting Co", body: "Amount due: €120.00\nInvoice date: 28 Oct 2026" },
			"invoice",
			"open",
			12_000,
		],
		[
			{ subject: "Your refund has been issued", body: "We refunded €35.00 to your card. Order #A12345." },
			"refund",
			"refunded",
			3_500,
		],
		[{ subject: "Credit note CN-7781", body: "Credit amount: €10.00 for order #A12345" }, "credit", "credited", 1_000],
		[
			{ subject: "Je factuur van oktober", body: "Te betalen: € 84,50\nFactuurnummer 2026-1001" },
			"invoice",
			"open",
			8_450,
		],
		[{ subject: "Ihre Rechnung RE-5521", body: "Rechnungsbetrag: 19,99 €" }, "invoice", "open", 1_999],
		[{ subject: "Votre reçu de paiement", body: "Montant payé : 15,00 €\nReçu n° 88123" }, "payment", "paid", 1_500],
		[{ subject: "Tu recibo de pago", body: "Total pagado: 25,00 €\nRecibo nº 4411" }, "payment", "paid", 2_500],
	];
	for (const [options, docType, status, amountMinor] of cases) {
		const found = run({ from: "billing@vendor.example", fromName: "Vendor", ...options });
		assert.ok(found, options.subject);
		assert.deepEqual([found.docType, found.status, found.amountMinor], [docType, status, amountMinor], options.subject);
	}
});

test("marketing mail with prices never records", () => {
	const marketing = [
		{ subject: "Black Friday: 40% off everything", body: "Shop now! Jackets from €49.99. Total savings up to €100." },
		{ subject: "New arrivals just for you", body: "Sneakers now €89.95. Buy now and get free shipping." },
		{ subject: "Your weekly deals", body: "Headphones €59.00, was €99.00. Limited time." },
		{ subject: "Pricing update", body: "Our Pro plan is now $19.99 per month for new customers." },
		{ subject: "Get paid faster with Invoicely", body: "Send your first invoice today. Plans from $9.00." },
		{ subject: "Uitverkoop: 30% korting", body: "Nu vanaf € 19,95. Bestel nu!" },
	];
	for (const options of marketing) {
		assert.equal(run({ from: "news@shop.example", fromName: "Shop", ...options }), null, options.subject);
		assert.equal(run({ from: "news@shop.example", fromName: "Shop", facts: { list: true }, ...options }), null);
	}
	// A real receipt that also advertises is still recorded, unless it comes as list mail.
	const receipt = {
		subject: "Your receipt from Shop",
		body: "Amount paid: €42.00\nReceipt #R-1001\nSave 20% off next time!",
	};
	assert.equal(run(receipt)?.status, "paid");
	assert.equal(run({ ...receipt, facts: { list: true } }), null);
});

test("phishing, spam, muted, spoofed and model-flagged mail never records, nor a failed payment", () => {
	assert.ok(run(STRIPE_RECEIPT));
	for (const facts of [{ phishing: ["lookalike_domain"] }, { spam: true }, { muted: true }, { authPassed: false }])
		assert.equal(run({ ...STRIPE_RECEIPT, facts }), null, JSON.stringify(facts));
	assert.equal(run({ ...STRIPE_RECEIPT, model: { suspicious: { flagged: true } } }), null);
	assert.equal(
		run({
			subject: "Payment failed",
			body: "We were unable to process your payment of €12.00. Update your payment method.",
		}),
		null,
	);
});

test("one weak signal is not enough, and the model alone never makes a payment", () => {
	// A personal note that mentions an amount: no document type, no billing evidence.
	assert.equal(
		run({ from: "anna@friends.example", fromName: "Anna", subject: "Dinner", body: "You owe me €30.00" }),
		null,
	);
	// A body-only type needs a labelled amount and a billing sender.
	assert.equal(
		run({ from: "anna@friends.example", fromName: "Anna", subject: "Hi", body: "Thanks, I paid €30.00 yesterday" }),
		null,
	);
	const modelOnly = {
		from: "anna@friends.example",
		fromName: "Anna",
		subject: "Hi",
		body: "See you soon",
		model: { modules: { finance: { vendor: "Shop", amount: "30.00", currency: "EUR", docType: "payment" } } },
	};
	assert.equal(run(modelOnly), null);
});

test("the model fills an amount the receipt left out, and the row says so", () => {
	const found = run({
		subject: "Your receipt from Shop",
		body: "Thanks for your order. Receipt #R-2002. Your total is in the attached PDF.",
		model: { modules: { finance: { amount: "42.00", currency: "EUR", docType: "payment" } } },
	});
	assert.equal(found?.amountMinor, 4_200);
	assert.deepEqual(found?.modelFields, ["amount", "currency"]);
});

test("the scan prefilter reads only mail with a billing subject, sender or document attachment", () => {
	const light = (from, subject, attachments = []) => ({ from, subject, attachments });
	assert.equal(payments.worthScanning(light("Stripe <receipts+acct_1@stripe.com>", "Hello")), true);
	assert.equal(payments.worthScanning(light("Anna <anna@friends.example>", "Your invoice INV-1")), true);
	assert.equal(
		payments.worthScanning(
			light("Anna <anna@friends.example>", "Hi", [{ filename: "invoice-2041.pdf", contentType: "application/pdf" }]),
		),
		true,
	);
	assert.equal(payments.worthScanning(light("Anna <anna@friends.example>", "Dinner on Friday?")), false);
});

const entry = (overrides) => ({
	id: "p1",
	source: "payment",
	docType: "payment",
	status: "paid",
	vendor: "Shop",
	group: "vendor:shop.example",
	amountMinor: 1_000,
	currency: "EUR",
	documentOn: "2026-11-03",
	periodStartOn: null,
	messageId: "m1",
	subscriptionId: null,
	...overrides,
});

test("month totals are per currency and never converted or added across currencies", () => {
	const totals = list.monthTotals([
		entry({ id: "a", amountMinor: 50_000, currency: "USD" }),
		entry({ id: "b", amountMinor: 4_200, currency: "EUR" }),
		entry({ id: "c", amountMinor: 1_000, currency: "EUR", docType: "refund", status: "refunded" }),
		entry({ id: "d", amountMinor: 12_000, currency: "EUR", docType: "invoice", status: "open", group: "vendor:host" }),
		entry({ id: "e", amountMinor: 900, currency: "GBP", documentOn: "2026-10-30" }),
		entry({ id: "f", amountMinor: 700, currency: "EUR", docType: "failed_payment", status: "failed" }),
	]);
	assert.deepEqual(totals, [
		{ month: "2026-11", currency: "EUR", paidMinor: 4_200, refundedMinor: 1_000, openMinor: 12_000 },
		{ month: "2026-11", currency: "USD", paidMinor: 50_000, refundedMinor: 0, openMinor: 0 },
		{ month: "2026-10", currency: "GBP", paidMinor: 900, refundedMinor: 0, openMinor: 0 },
	]);
});

test("an invoice paid by a recorded payment counts once and shows as paid", () => {
	const invoice = entry({
		id: "inv",
		docType: "invoice",
		status: "open",
		documentOn: "2026-10-20",
		amountMinor: 12_000,
	});
	const payment = entry({
		id: "pay",
		docType: "payment",
		status: "paid",
		documentOn: "2026-11-02",
		amountMinor: 12_000,
	});
	const other = entry({ id: "x", docType: "invoice", status: "open", group: "vendor:other", amountMinor: 12_000 });
	const entries = [invoice, payment, other];
	const paired = list.pairedEntryIds(entries);
	assert.deepEqual([...paired], ["inv"]);
	assert.equal(list.shownStatus(invoice, paired), "paid");
	assert.equal(list.shownStatus(other, paired), "open");
	const totals = list.monthTotals(entries, paired);
	assert.deepEqual(
		totals.map((total) => [total.month, total.paidMinor, total.openMinor]),
		[["2026-11", 12_000, 12_000]],
	);
});

test("a subscription's documents follow their type: an invoice is charged, a failed payment never counts", () => {
	assert.equal(list.ledgerStatus("invoice"), "paid");
	assert.equal(list.ledgerStatus("refund"), "refunded");
	assert.equal(list.ledgerStatus("credit"), "credited");
	assert.equal(list.ledgerStatus("failed_payment"), "failed");
	assert.equal(payments.initialStatus("invoice"), "open");
});
