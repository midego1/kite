import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const detect = await loadFinance("detect-utils");
const payments = await loadFinance("payment-utils");
const list = await loadFinance("payment-list-utils");
const model = await loadFinance("model-utils");
const detectDocs = await loadFinance("document-utils");

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
	subject: "Your Kestrel Atlas receipt [#1114-6093]",
	body: [
		"Kestrel Atlas",
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
		"Kestrel Atlas signup fee   $500.00",
		"Amount charged   $500.00",
		"",
		"Questions? Contact us at help@atlas.invalid.",
	].join("\n"),
};

test("a one-off Stripe receipt lands as paid, USD 500.00, from the merchant, on the date paid", () => {
	assert.deepEqual(run(STRIPE_RECEIPT), {
		vendor: "Kestrel Atlas",
		vendorKey: "stripe.com:kestrel-atlas",
		docType: "payment",
		status: "paid",
		amountMinor: 50_000,
		currency: "USD",
		documentOn: "2026-11-02",
		attachmentId: null,
		modelFields: [],
		docRef: "1114-6093:50000USD",
		mailRef: null,
	});
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

test("a subscription invoice a failed payment followed stays open; a settled or uncontested one is charged", () => {
	const sub = (overrides) => entry({ source: "subscription", group: "fsub_1", subscriptionId: "fsub_1", ...overrides });
	const invoice = sub({ id: "inv", docType: "invoice", status: "paid", documentOn: "2026-10-01" });
	const failed = sub({
		id: "fail",
		docType: "failed_payment",
		status: "failed",
		amountMinor: null,
		documentOn: "2026-10-03",
	});
	const older = sub({ id: "old", docType: "invoice", status: "paid", documentOn: "2026-08-01" });
	const entries = [invoice, failed, older];
	assert.deepEqual([...list.unpaidLedgerInvoices(entries, new Set())], ["inv"]);
	assert.deepEqual([...list.unpaidLedgerInvoices(entries, new Set(["inv"]))], [], "a payment settled it");
	assert.deepEqual([...list.unpaidLedgerInvoices([older, failed], new Set())], [], "the failure was too late");
});

test("review probe: a reminder or an invoice that says it is not paid is an open invoice, in five languages", () => {
	const reminders = [
		["Reminder: invoice 2026-1101 has not been paid", "Amount due: €84.10"],
		["Herinnering: factuur 2026-1101 nog niet betaald", "Te betalen: € 84,10"],
		["Zahlungserinnerung: Rechnung 2026-1101 noch nicht bezahlt", "Rechnungsbetrag: 84,10 €"],
		["Relance : facture 2026-1101 pas encore payée", "Montant dû : 84,10 €"],
		["Recordatorio: factura 2026-1101 aún no se ha pagado", "Importe a pagar: 84,10 €"],
		["Your invoice 2026-1101 is not paid yet", "Amount due: €84.10"],
		["Betaling factuur 2026-1101: niet betaald", "Openstaand bedrag: € 84,10\nTe betalen: € 84,10"],
		["Rechnung 2026-1101 ist unbezahlt", "Offener Betrag: 84,10 €\nRechnungsbetrag: 84,10 €"],
	];
	for (const [subject, body] of reminders) {
		const found = run({ from: "billing@energy.example", fromName: "Energy Co", subject, body });
		assert.ok(found, subject);
		assert.deepEqual([found.docType, found.status, found.amountMinor], ["invoice", "open", 8_410], subject);
	}
	for (const subject of ["Unpaid invoice 2026-1101", "Onbetaalde factuur 2026-1101"]) {
		const found = run({ from: "billing@energy.example", fromName: "Energy Co", subject, body: "Amount due: €84.10" });
		assert.deepEqual([found?.docType, found?.status], ["invoice", "open"], subject);
	}
	// A receipt that prints a zero balance is still a payment.
	const paid = run({
		subject: "Your receipt from Shop #R-1001",
		body: "Thank you for your payment.\nAmount paid: €42.00\nOutstanding balance: €0.00",
	});
	assert.deepEqual([paid?.docType, paid?.status], ["payment", "paid"]);
	// The model cannot turn a reminder into a payment.
	const modelPaid = run({
		subject: "Billing reminder for order 2026-1101",
		body: "Please transfer the total.\nTotal due: €84.10\nOrder 2026-1101",
		from: "billing@energy.example",
		model: { modules: { finance: { docType: "payment" } } },
	});
	assert.equal(modelPaid?.status, "open");
});

test("review probe: replies, forwards and a person's mail without the document record nothing", () => {
	const forwarded = {
		from: "michiel.example@gmail.com",
		fromName: "Michiel",
		subject: "Fwd: Your receipt from Acme #1234",
		body: "---------- Forwarded message ----------\nAmount paid: $500.00\nReceipt #1234",
	};
	assert.equal(run(forwarded), null);
	for (const prefix of ["Re:", "RE:", "AW:", "WG:", "Doorst:", "TR:", "RV:", "Fw[2]:"])
		assert.equal(run({ subject: `${prefix} Your receipt from Shop #R-1001` }), null, prefix);
	const friend = {
		from: "friend.example@gmail.com",
		fromName: "A Friend",
		subject: "Invoice for the trip",
		body: "Hi! Total paid €120.00, Order number AB12345. Thanks!",
	};
	assert.equal(run(friend), null, "a free-mail sender without a document attachment");
	const withPdf = run({
		...friend,
		attachments: [{ id: "a1", contentType: "application/pdf", filename: "invoice-AB12345.pdf", size: 900 }],
	});
	assert.equal(withPdf?.vendorKey, "mail:friend.example@gmail.com", "keyed by the person, not gmail.com");
});

test("review probe: a borrowed display name keeps the real sender's key", () => {
	const spoofed = run({
		from: "billing@attacker-example.test",
		fromName: "Apple",
		subject: "Your receipt #R-99881",
		body: "Amount paid €999.00\nReceipt #R-99881",
	});
	assert.equal(spoofed?.vendor, "Apple");
	assert.equal(spoofed?.vendorKey, "attacker-example.test", "the row shows this domain next to the name");
});

test("document and message references for dedupe", () => {
	assert.equal(payments.documentReference("Your Kestrel Atlas receipt [#1114-6093]", ""), "1114-6093");
	assert.equal(payments.documentReference("Invoice INV-2041 from Hosting Co", ""), "INV-2041");
	assert.equal(payments.documentReference("Payment received", "Order number ab12345 shipped"), "AB12345");
	assert.equal(payments.documentReference("Invoice today", "Thanks"), null);
	assert.equal(payments.messageReference(" <R-1@Vendor.Example> "), "r-1@vendor.example");
	assert.equal(payments.messageReference("no-at-sign"), null);
	assert.equal(payments.messageReference(null), null);
	const reminder = run({ subject: "Reminder: invoice INV-2041 has not been paid", body: "Amount due: €120.00" });
	assert.equal(reminder?.docRef, "INV-2041");
});

test("an invoice and a payment naming the same number pair first, whatever amount and date", () => {
	const older = entry({
		id: "a",
		docType: "invoice",
		status: "open",
		amountMinor: 10_000,
		documentOn: "2026-10-01",
		docRef: "INV-1",
	});
	const nearer = entry({
		id: "b",
		docType: "invoice",
		status: "open",
		amountMinor: 10_000,
		documentOn: "2026-10-30",
		docRef: "INV-2",
	});
	const payment = entry({
		id: "p",
		docType: "payment",
		status: "paid",
		amountMinor: 10_000,
		documentOn: "2026-11-01",
		docRef: "INV-1",
	});
	assert.deepEqual([...list.pairedEntryIds([older, nearer, payment])], ["a"]);
	const discounted = entry({
		id: "q",
		docType: "payment",
		amountMinor: 9_500,
		documentOn: "2026-12-20",
		docRef: "INV-2",
	});
	assert.deepEqual([...list.pairedEntryIds([nearer, discounted])], ["b"]);
});

test("review 2: a paid receipt that mentions an unpaid balance of zero or a condition stays paid", () => {
	const paid = [
		["Your receipt #R-2001", "Amount paid €40.00\nUnpaid balance: €0.00"],
		[
			"Payment received for invoice INV-77",
			"Thank you. €40.00 received.\nIf you have not paid by direct debit, nothing else is needed.",
		],
		["Betalingsbewijs #R-2001", "Betaald bedrag: € 40,00\nOnbetaald saldo: € 0,00"],
		[
			"Betaling ontvangen voor factuur 2026-77",
			"We ontvingen € 40,00.\nAls u nog niet betaald heeft via incasso, hoeft u niets te doen.",
		],
		["Zahlungsbestätigung #R-2001", "Bezahlter Betrag: 40,00 €\nNoch nicht bezahlt: 0,00 €"],
		[
			"Zahlung erhalten für Rechnung 2026-77",
			"Wir haben 40,00 € erhalten.\nFalls Sie noch nicht bezahlt haben, ist nichts weiter zu tun.",
		],
		["Your receipt from Shop #R-2002", "Amount paid: €40.00\nKeep this receipt as a reminder of your order."],
	];
	for (const [subject, body] of paid) {
		const found = run({ from: "billing@shop.example", fromName: "Shop", subject, body });
		assert.deepEqual([found?.docType, found?.status], ["payment", "paid"], subject);
	}
});

test("review 2: what says the money is still owed, in the subject or on a line of its own", () => {
	const docs = detectDocs;
	assert.equal(docs.subjectSaysOwed("Reminder: invoice 2026-1101"), true);
	assert.equal(docs.subjectSaysOwed("Herinnering: factuur nog niet betaald"), true);
	assert.equal(docs.subjectSaysOwed("Your receipt"), false);
	assert.equal(docs.bodySaysOwed("Invoice 2026-77 has not been paid\nAmount due €50.00"), true);
	assert.equal(docs.bodySaysOwed("Rechnung 2026-77 ist noch nicht bezahlt: 50,00 €"), true);
	assert.equal(docs.bodySaysOwed("Unpaid balance: €0.00"), false);
	assert.equal(docs.bodySaysOwed("If you have not paid yet, use the link"), false);
	assert.equal(docs.bodySaysOwed("Amount paid €40.00\nInvoice 2026-77 not paid"), false, "a paid label wins");
	assert.equal(docs.bodySaysOwed("Keep this as a reminder"), false);
});

test("review 2: partial refunds and instalments under one number are separate rows; invoices collapse", () => {
	const refund = (amount) =>
		run({ subject: "Refund for order #A12345", body: `We refunded €${amount} to your card. Order #A12345.` });
	assert.equal(refund("20.00")?.docRef, "A12345:2000EUR");
	assert.equal(refund("15.00")?.docRef, "A12345:1500EUR");
	const instalment = (amount) =>
		run({ subject: "Payment received for invoice INV-500", body: `Amount paid: €${amount}\nInvoice INV-500` });
	assert.notEqual(instalment("100.00")?.docRef, instalment("200.00")?.docRef);
	assert.equal(payments.rowReference("invoice", "INV-500", { minor: 30_000, currency: "EUR" }), "INV-500");
	assert.equal(payments.rowReference("payment", null, { minor: 1, currency: "EUR" }), null);
	assert.equal(payments.referenceNumber("INV-500:10000EUR"), "INV-500");
	assert.equal(payments.referenceNumber(null), null);
	// An instalment still settles its invoice by number.
	const invoice = entry({ id: "inv", docType: "invoice", status: "open", amountMinor: 30_000, docRef: "INV-500" });
	const first = entry({ id: "p1", docType: "payment", amountMinor: 10_000, docRef: "INV-500:10000EUR" });
	assert.deepEqual([...list.pairedEntryIds([invoice, first])], ["inv"]);
});
