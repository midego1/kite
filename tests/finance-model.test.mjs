import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const detect = await loadFinance("detect-utils");
const model = await loadFinance("model-utils");
const text = await loadFinance("text-utils");

const RECEIVED = "2026-10-14T09:00:00.000Z";
const DAY = "2026-10-14";

function stepInput({
	from = "billing@streamflix.example",
	fromName = "Streamflix Billing",
	subject = "Your receipt from Streamflix",
	body = "Thanks for your payment.\nAmount paid: $9.99",
	facts = {},
	attachments = [],
	extension,
	category = "receipt",
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
			...facts,
		},
		headers: { listUnsubscribe: null, listUnsubscribePost: null, listId: null },
		attachments,
		model: extension === undefined ? null : { category, modules: { finance: extension } },
	};
}

/** The step's whole path, as production runs it: analyse with the model, validate and merge the extension, then build the card. */
function detectWith(options, context = { tracked: null, recurring: null }) {
	const input = stepInput(options);
	const deterministic = detect.analyzeMessage(input, "UTC");
	const extraction = model.parseModelExtraction(model.modelExtensionOf(input), {
		messageDay: deterministic.dates.messageDay,
		paymentFailed: deterministic.paymentFailed,
	});
	return detect.buildDetection(model.mergeDetection(deterministic, extraction), context);
}

const parse = (raw, paymentFailed = false) => model.parseModelExtraction(raw, { messageDay: DAY, paymentFailed });

// The wantsModel hint

test("the hint asks only for receipt-like mail the detector could not complete", () => {
	assert.equal(detect.RECEIPT_MODEL_THRESHOLD, 3);
	const ask = (options) => detect.wantsModelForReceipt(stepInput(options), "UTC");
	assert.equal(ask({}), true, "receipt keyword and an amount, but no cycle or date");
	assert.equal(ask({ body: "Thanks for your payment." }), true, "no amount is a gap too");
	assert.equal(
		ask({ body: "Thanks for your payment.\nAmount paid: $9.99/month, renews on 1 Nov 2026." }),
		false,
		"a complete receipt costs no model request",
	);
	assert.equal(
		ask({ body: "Plan: $9.99/month. Your trial ends on 1 Nov 2026." }),
		false,
		"a trial end stands in for the renewal date",
	);
	assert.equal(ask({ body: "Amount paid: $9.99/month" }), true, "a cycle without a stated date is a gap");
	assert.equal(ask({ facts: { phishing: ["credential_request"] } }), false);
	assert.equal(ask({ facts: { spam: true } }), false);
	assert.equal(
		ask({ subject: "Hello from Streamflix", from: "news@streamflix.example" }),
		false,
		"no subject keyword and no document attachment",
	);
	assert.equal(
		ask({ subject: "Your receipt", from: "news@streamflix.example", body: "Thanks." }),
		false,
		"a subject keyword alone scores 2",
	);
	assert.equal(
		ask({
			subject: "Hello from Streamflix",
			from: "news@streamflix.example",
			body: "Amount paid: $9.99",
			attachments: [{ id: "a1", filename: "invoice-1001.pdf", contentType: "application/pdf", size: 100 }],
		}),
		false,
		"a document attachment counts, but amount and attachment only score 2",
	);
	assert.equal(
		ask({
			subject: "Hello from Streamflix",
			body: "Amount paid: $9.99",
			attachments: [{ id: "a1", filename: "invoice-1001.pdf", contentType: "application/pdf", size: 100 }],
		}),
		true,
		"billing sender, amount and a document attachment score 3",
	);
});

test("the receipt score counts deterministic signals only", () => {
	assert.equal(detect.receiptScore(new Set(["subject_keyword", "amount"])), 3);
	assert.equal(detect.receiptScore(new Set(["recurring", "model_receipt", "model_fields"])), 0);
	assert.equal(detect.receiptCondition(new Set(["billing_sender", "amount", "cycle"])), false);
	assert.equal(detect.receiptCondition(new Set(["invoice_attachment", "billing_sender", "amount"])), true);
});

// parseModelExtraction

test("a value that is not an object is absent, and unknown keys are never read", () => {
	for (const raw of [undefined, null, "monthly", 42, ["a"], {}]) assert.equal(parse(raw), null);
	assert.deepEqual(parse({ cycle: "monthly", cancelUrl: "https://evil.test/c", link: "https://evil.test" }), {
		cycle: "monthly",
	});
	assert.equal(model.modelExtensionOf({ model: null }), undefined);
	assert.equal(model.modelExtensionOf({ model: { modules: "x" } }), undefined);
	assert.deepEqual(model.modelExtensionOf({ model: { modules: { finance: { a: 1 } } } }), { a: 1 });
});

test("each field is validated on its own", () => {
	const parsed = parse({
		vendor: "\u202eStreamflix\u200b Billing",
		plan: "x".repeat(81),
		amount: "17.99",
		currency: "USD",
		cycle: "fortnightly",
		nextRenewalOn: "2026-11-14",
		trialEndsOn: "2026-02-30",
		docType: "receipt",
	});
	assert.deepEqual(parsed, {
		vendor: "Streamflix",
		amount: { minor: 1799, currency: "USD" },
		nextRenewalOn: "2026-11-14",
	});
});

test("amounts are valid only as a pair with the currency's minor digits and within the bounds", () => {
	const amount = (value, currency) => parse({ amount: value, currency })?.amount;
	assert.deepEqual(amount("17.99", "USD"), { minor: 1799, currency: "USD" });
	assert.deepEqual(amount("17", "USD"), { minor: 1700, currency: "USD" });
	assert.deepEqual(amount("1500", "JPY"), { minor: 1500, currency: "JPY" });
	for (const [value, currency] of [
		["17.9", "USD"],
		["1500.00", "JPY"],
		["1.2345", "USD"],
		["17.99", "XYZ"],
		["17.99", null],
		[null, "USD"],
		["0", "USD"],
		["0.00", "USD"],
		["1000001", "USD"],
		["-5", "USD"],
		["17,99", "EUR"],
	])
		assert.equal(amount(value, currency), undefined, `${value} ${currency}`);
	assert.deepEqual(amount("1000000", "USD"), { minor: 100_000_000, currency: "USD" });
});

test("dates must be real days from one day before the message to two years after it", () => {
	const day = (value) => parse({ nextRenewalOn: value, trialEndsOn: value });
	assert.deepEqual(day("2026-10-13"), { nextRenewalOn: "2026-10-13", trialEndsOn: "2026-10-13" });
	assert.deepEqual(day("2028-10-14"), { nextRenewalOn: "2028-10-14", trialEndsOn: "2028-10-14" });
	for (const value of ["2026-10-12", "2028-10-15", "2026-02-30", "2026-13-01", "14/10/2026", "2026-1-1"])
		assert.equal(day(value), null, value);
});

test("the model may say failed_payment only when the deterministic phrases matched", () => {
	assert.equal(parse({ docType: "failed_payment" }), null);
	assert.deepEqual(parse({ docType: "failed_payment" }, true), { docType: "failed_payment" });
	assert.deepEqual(parse({ docType: "refund" }), { docType: "refund" });
});

// mergeDetection: the six rules

test("rule 1: a confident deterministic value always wins", () => {
	const result = detectWith({
		fromName: "Streamflix",
		body: "Plan: Premium\nAmount paid: $17.99/month, renews on 1 Nov 2026.",
		extension: {
			vendor: "Other Vendor",
			plan: "Basic",
			amount: "17.99",
			currency: "USD",
			cycle: "yearly",
			nextRenewalOn: "2026-12-01",
			docType: "invoice",
		},
	});
	assert.deepEqual(
		{
			vendor: result.payload.vendor,
			plan: result.payload.plan,
			cycle: result.payload.cycle,
			nextRenewalOn: result.payload.nextRenewalOn,
			docType: result.payload.document.docType,
			modelFields: result.payload.modelFields,
		},
		{
			vendor: "Streamflix",
			plan: "Premium",
			cycle: "monthly",
			nextRenewalOn: "2026-11-01",
			docType: "payment",
			modelFields: [],
		},
	);
	assert.equal(result.payload.signals.includes("model_fields"), false);
});

test("rule 2: the model fills empty fields and replaces a domain vendor, an estimated date and a body-only type", () => {
	const result = detectWith({
		fromName: "",
		from: "billing@cloudbox.example",
		subject: "Your receipt",
		body: "Thanks.\nAmount paid: $9.99",
		extension: { vendor: "Cloud Box", plan: "Plus", cycle: "monthly", nextRenewalOn: "2026-11-14" },
	});
	assert.equal(result.payload.vendor, "Cloud Box");
	assert.equal(result.payload.vendorKey, "cloudbox.example", "the vendor key stays the sender's");
	assert.equal(result.payload.plan, "Plus");
	assert.equal(result.payload.cycle, "monthly");
	assert.equal(result.payload.nextRenewalOn, "2026-11-14");
	assert.equal(result.payload.renewalEstimated, false);
	assert.deepEqual(result.payload.modelFields, ["vendor", "plan", "cycle", "nextRenewalOn"]);

	const estimated = detectWith({
		body: "Amount paid: $9.99/month",
		extension: { nextRenewalOn: "2026-11-20" },
	});
	assert.equal(estimated.payload.nextRenewalOn, "2026-11-20");
	assert.equal(estimated.payload.renewalEstimated, false);

	const bodyOnly = detectWith({
		subject: "Your Streamflix subscription",
		body: "Amount paid: $9.99/month, renews on 1 Nov 2026.",
		extension: { docType: "invoice" },
	});
	assert.equal(bodyOnly.payload.document.docType, "invoice");
	assert.deepEqual(bodyOnly.payload.modelFields, ["docType"]);
	assert.ok(bodyOnly.payload.signals.includes("doc_invoice"));
	assert.equal(bodyOnly.payload.signals.includes("doc_payment"), false);
});

test("rule 3: an amount or currency conflict keeps the detector's value and asks to check it", () => {
	const result = detectWith({ extension: { amount: "12.49", currency: "EUR", cycle: "monthly" } });
	assert.equal(result.payload.amountMinor, 999);
	assert.equal(result.payload.currency, "USD");
	assert.deepEqual(result.payload.modelDisagrees, ["amount", "currency"]);
	assert.equal(result.reason, "subscription_check_amount");
	const same = detectWith({ extension: { amount: "9.99", currency: "USD", cycle: "monthly" } });
	assert.deepEqual(same.payload.modelDisagrees, []);
	assert.equal(same.reason, "subscription");
	assert.deepEqual(model.modelDisagrees(null, { minor: 1, currency: "USD" }), []);
	assert.deepEqual(model.modelDisagrees({ minor: 999, currency: "USD" }, { minor: 1249, currency: "USD" }), ["amount"]);
});

test("rule 3: payment failures and refunds keep their own reason when the amount disagrees", () => {
	const tracked = {
		id: "sub-1",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 999,
		currency: "USD",
		cycle: "monthly",
	};
	const refund = detectWith(
		{ subject: "Your Streamflix refund", body: "Refund issued: $9.99", extension: { amount: "5.00", currency: "USD" } },
		{ tracked, recurring: null },
	);
	assert.equal(refund.payload.event, "refund");
	assert.equal(refund.reason, "subscription_refund");
	assert.deepEqual(refund.payload.modelDisagrees, ["amount"]);
});

test("rule 4: the vendor key, cancel link, event and failed payment never come from the model", () => {
	const result = detectWith({
		extension: {
			cycle: "monthly",
			cancelUrl: "https://evil.test/c",
			vendorKey: "evil.test",
			docType: "failed_payment",
		},
	});
	assert.equal(result.payload.vendorKey, "streamflix.example");
	assert.equal(result.payload.cancelLink, null);
	assert.equal(result.payload.event, "new");
	assert.equal(result.payload.document.docType, "payment");
	assert.equal(JSON.stringify(result).includes("evil.test"), false);
	const tracked = {
		id: "sub-1",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 999,
		currency: "USD",
		cycle: "monthly",
	};
	const credit = detectWith(
		{ subject: "Your Streamflix account", body: "Amount: $9.99", extension: { docType: "credit" } },
		{ tracked, recurring: null },
	);
	assert.equal(credit.payload.event, "refund", "a model credit can only make a 'Record it?' card");
});

test("rule 5: the fields the model filled are recorded with a model_fields signal", () => {
	const result = detectWith({ extension: { cycle: "monthly", nextRenewalOn: "2026-11-14", docType: "payment" } });
	assert.deepEqual(result.payload.modelFields, ["cycle", "nextRenewalOn"]);
	assert.ok(result.payload.signals.includes("model_fields"));
	assert.equal(result.reason, "subscription");
});

test("rule 6: model fields make a candidate only with the deterministic receipt condition", () => {
	assert.equal(detectWith({ extension: null }), null, "the detector alone has no cycle");
	assert.ok(detectWith({ extension: { cycle: "monthly" } }), "score 3 with a receipt keyword and a model cycle");
	assert.equal(
		detectWith({
			subject: "Hello from Streamflix",
			from: "news@streamflix.example",
			extension: { cycle: "monthly", nextRenewalOn: "2026-11-14" },
		}),
		null,
		"no billing evidence: the model alone never makes a candidate",
	);
	assert.equal(
		detectWith({ body: "Thanks.", extension: { cycle: "monthly" } }),
		null,
		"the merged result still needs an amount",
	);
	assert.ok(
		detectWith({ body: "Thanks.", extension: { amount: "9.99", currency: "USD", cycle: "monthly" } }),
		"an amount from the model counts for the rule",
	);
});

test("rule 6: a model receipt category adds no weight once a field came from the model", () => {
	const personal = {
		from: "sam@partner.test",
		fromName: "Sam Partner",
		subject: "Hello",
		body: "I will send the monthly notes.",
		facts: { automatic: false },
		category: "receipt",
	};
	assert.equal(
		detectWith({ ...personal, extension: { amount: "9.99", currency: "USD" } }),
		null,
		"only a cycle is deterministic: the model's receipt and amount make no card",
	);
	assert.ok(
		detectWith({ ...personal, body: "I will send the monthly notes. $9.99", extension: null }),
		"without model fields the model_receipt weight still counts",
	);
});

test("rule 1: a subject classification without an amount survives the merge", () => {
	const result = detectWith({
		subject: "Your Streamflix invoice",
		body: "Thanks for your subscription. Billed monthly, renews on 1 Nov 2026.",
		extension: { amount: "9.99", currency: "USD" },
	});
	assert.equal(result.payload.amountMinor, 999);
	assert.equal(result.payload.document.docType, "invoice");
	assert.deepEqual(result.payload.modelFields, ["amount", "currency"]);
	assert.ok(result.payload.signals.includes("doc_invoice"));
});

test("rule 1: a model refund never replaces a confident invoice", () => {
	const tracked = {
		id: "sub-1",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 999,
		currency: "USD",
		cycle: "monthly",
	};
	const options = {
		subject: "Your invoice",
		body: "Thanks for your subscription. Billed monthly.",
		extension: { amount: "9.99", currency: "USD", docType: "refund" },
	};
	for (const context of [
		{ tracked, recurring: null },
		{ tracked: null, recurring: null },
	]) {
		const result = detectWith(options, context);
		assert.notEqual(result.payload.event, "refund");
		assert.equal(result.payload.document.docType, "invoice");
		assert.equal(result.payload.modelFields.includes("docType"), false);
		assert.equal(result.payload.signals.includes("doc_refund"), false);
	}
});

test("an extension with nothing valid gives exactly the detector's result", () => {
	const base = detectWith({ body: "Amount paid: $9.99/month, renews on 1 Nov 2026.", extension: {} });
	for (const extension of ["monthly", { cycle: "biweekly" }, { cancelUrl: "https://evil.test" }])
		assert.deepEqual(detectWith({ body: "Amount paid: $9.99/month, renews on 1 Nov 2026.", extension }), base);
});

test("the card names what the assistant read", () => {
	assert.equal(text.modelFieldsNote([]), null);
	assert.equal(text.modelFieldsNote(undefined), null);
	assert.equal(text.modelFieldsNote(["cycle"]), "Cycle read by the assistant");
	assert.equal(text.modelFieldsNote(["cycle", "nextRenewalOn"]), "Cycle and renewal date read by the assistant");
	assert.equal(
		text.modelFieldsNote(["vendor", "amount", "currency", "trialEndsOn"]),
		"Vendor, amount, currency and trial end read by the assistant",
	);
	assert.equal(text.modelFieldsNote(["nextRenewalOn", "docType"], ["vendor", "cycle"]), null);
});
