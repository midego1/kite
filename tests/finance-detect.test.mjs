import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const amounts = await loadFinance("amount-utils");
const dates = await loadFinance("date-utils");
const vendors = await loadFinance("vendor-utils");
const detect = await loadFinance("detect-utils");
const text = await loadFinance("text-utils");

const RECEIVED = "2026-10-14T09:00:00.000Z";

function stepInput({
	from = "billing@streamflix.example",
	fromName = "Streamflix Billing",
	subject = "Your Streamflix invoice",
	body = "Your invoice INV-1001: $17.99/month, renews on 1 Nov 2026.",
	facts = {},
	headers = {},
	attachments = [],
	model = null,
	receivedAt = RECEIVED,
} = {}) {
	return {
		message: { id: "m1", mailboxId: "mb1", from, fromName, subject, receivedAt, textExcerpt: body },
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
		headers: { listUnsubscribe: null, listUnsubscribePost: null, listId: null, ...headers },
		attachments,
		model,
	};
}

function run(options = {}, context = { tracked: null, recurring: null }) {
	const analysis = detect.analyzeMessage(stepInput(options), "UTC");
	return analysis ? detect.buildDetection(analysis, context) : null;
}

const tracked = (overrides = {}) => ({
	id: "sub-1",
	vendorKey: "streamflix.example",
	plan: null,
	amountMinor: 1799,
	currency: "USD",
	cycle: "monthly",
	...overrides,
});

// Amounts and currencies

test("amount separators and minor digits", () => {
	const one = (value) => amounts.parseAmounts(value).map(({ minor, currency }) => [minor, currency]);
	assert.deepEqual(one("1.299,00 €"), [[129900, "EUR"]]);
	assert.deepEqual(one("$1,299.00"), [[129900, "USD"]]);
	assert.deepEqual(one("¥1,500"), [[1500, "JPY"]]);
	assert.deepEqual(one("BHD 1.500"), [[1500, "BHD"]]);
	assert.deepEqual(one("12,50 EUR"), [[1250, "EUR"]]);
	assert.deepEqual(one("£9"), [[900, "GBP"]]);
	assert.deepEqual(one("₹499"), [[49900, "INR"]]);
	assert.deepEqual(one("CHF 12.00"), [[1200, "CHF"]]);
	assert.deepEqual(one("$17.9"), []);
	assert.deepEqual(one("¥15.50"), []);
	assert.deepEqual(one("$12,34,567"), []);
	assert.deepEqual(one("ABC 12.00"), []);
	assert.equal(amounts.minorDigits("JPY"), 0);
	assert.equal(amounts.minorDigits("KWD"), 3);
	assert.equal(amounts.minorDigits("EUR"), 2);
	assert.equal(amounts.toMinorUnits("1234", 2), 123400);
	assert.equal(amounts.toMinorUnits("1234,5", 2), null);
});

test("$ is USD unless a qualifier or a code is on the same line", () => {
	const currency = (value) => amounts.parseAmounts(value)[0]?.currency;
	assert.equal(currency("$17.99"), "USD");
	assert.equal(currency("CA$17.99"), "CAD");
	assert.equal(currency("A$17.99"), "AUD");
	assert.equal(currency("NZ$17.99"), "NZD");
	assert.equal(currency("HK$17.99"), "HKD");
	assert.equal(currency("S$17.99"), "SGD");
	assert.equal(currency("MX$17.99"), "MXN");
	assert.equal(currency("R$17,99"), "BRL");
	assert.equal(currency("US$17.99"), "USD");
	assert.equal(currency("Total $17.99 (CAD)"), "CAD");
	assert.equal(currency("Total CAD\n$17.99"), "USD");
});

test("amount bounds", () => {
	assert.deepEqual(amounts.parseAmounts("$0.00"), []);
	assert.deepEqual(amounts.parseAmounts("$1,000,000.01"), []);
	assert.equal(amounts.parseAmounts("$1,000,000.00")[0].minor, 100_000_000);
	assert.equal(amounts.MAX_AMOUNT_MINOR, 100_000_000);
});

test("amount preference: a cycle or total line, then the largest under 10,000", () => {
	const pick = (value, preferred = () => false) => amounts.pickAmount(amounts.parseAmounts(value), preferred)?.minor;
	assert.equal(
		pick("Tax $1.50\nTotal $19.49", (line) => /total/i.test(line)),
		1949,
	);
	assert.equal(pick("Item $3.00\nItem $12.00\nBig $20,000.00"), 1200);
	assert.equal(pick("Only $20,000.00"), 2_000_000);
	assert.equal(pick("nothing here"), undefined);
	assert.equal(run({ body: "Tax $1.50. Plan Pro $17.99 per month, renews 1 Nov 2026" }).payload.amountMinor, 1799);
});

test("money formatting", () => {
	assert.equal(amounts.formatMoney(1799, "USD", "en"), "$17.99");
	assert.equal(amounts.formatMoney(1500, "JPY", "en"), "¥1,500");
	assert.equal(amounts.formatMoney(1500, "BHD", "en").replace(/\s/u, " "), "BHD 1.500");
	assert.equal(amounts.formatMoney(1799, "USD", "not a locale!"), "USD 17.99");
	assert.equal(amounts.formatDecimal(5, "USD"), "0.05");
	assert.equal(amounts.formatDecimal(1500, "JPY"), "1500");
});

// Dates

test("date formats in five languages", () => {
	const scan = (value, monthFirst = false) =>
		dates.scanDates(value, monthFirst).map((found) => dates.resolveDay(found, "2026-10-14"));
	assert.deepEqual(scan("2026-11-01"), ["2026-11-01"]);
	assert.deepEqual(scan("1 Nov 2026"), ["2026-11-01"]);
	assert.deepEqual(scan("Nov 1, 2026"), ["2026-11-01"]);
	assert.deepEqual(scan("November 1st"), ["2026-11-01"]);
	assert.deepEqual(scan("1 november 2026"), ["2026-11-01"]);
	assert.deepEqual(scan("1. November 2026"), ["2026-11-01"]);
	assert.deepEqual(scan("1er novembre 2026"), ["2026-11-01"]);
	assert.deepEqual(scan("1 de noviembre de 2026"), ["2026-11-01"]);
	assert.deepEqual(scan("3 mrt 2027"), ["2027-03-03"]);
	assert.deepEqual(scan("01/11/2026"), ["2026-11-01"]);
	assert.deepEqual(scan("11/01/2026", true), ["2026-11-01"]);
	assert.deepEqual(scan("25/12/2026", true), ["2026-12-25"]);
	assert.deepEqual(scan("30 Feb 2026 and 2026-02-30 and 31/04/2026"), []);
	assert.deepEqual(scan("Nov 2026"), []);
});

test("dates without a year roll to their next occurrence", () => {
	const found = (value) => dates.scanDates(value, false)[0];
	assert.equal(dates.resolveDay(found("1 Nov"), "2026-10-14"), "2026-11-01");
	assert.equal(dates.resolveDay(found("1 Oct"), "2026-10-14"), "2027-10-01");
	assert.equal(dates.resolveDay(found("14 Oct"), "2026-10-14"), "2026-10-14");
	assert.equal(dates.resolveDay(found("29 Feb"), "2026-10-14"), null);
	assert.equal(dates.resolveDay({ year: 2026, month: 2, day: 30 }, "2026-10-14"), null);
});

test("renewal dates lie between 31 days before and 2 years after the message", () => {
	const renewal = (body) => run({ body }).payload.nextRenewalOn;
	assert.equal(renewal("$17.99/month, renews on 1 Nov 2026"), "2026-11-01");
	assert.equal(renewal("$17.99/month, renews on 1 Oct 2028"), "2028-10-01");
	// Beyond the bounds the stated date is dropped and the renewal is estimated from the cycle.
	const far = run({ body: "$17.99/month, renews on 1 Nov 2028" }).payload;
	assert.deepEqual([far.nextRenewalOn, far.renewalEstimated], ["2026-11-14", true]);
	const past = run({ body: "$17.99/month, renews on 1 Sep 2026" }).payload;
	assert.deepEqual([past.nextRenewalOn, past.renewalEstimated], ["2026-11-14", true]);
	assert.equal(renewal("$17.99/month, renews on 20 Sep 2026"), "2026-09-20");
});

test("ambiguous numeric dates: day first unless USD or a .us sender, dropped when far", () => {
	const window = dates.receiptWindow("2026-10-14");
	const accept = (value, monthFirst) =>
		dates.acceptDay(dates.scanDates(value, monthFirst)[0], { messageDay: "2026-10-14", monthFirst }, window);
	assert.equal(accept("01/11/2026", false), "2026-11-01");
	assert.equal(accept("11/01/2026", true), "2026-11-01");
	assert.equal(accept("03/02/2027", false), null);
	assert.equal(accept("13/02/2027", false), "2027-02-13");
	assert.equal(run({ body: "€17.99/month, renews on 01/11/2026" }).payload.nextRenewalOn, "2026-11-01");
	assert.equal(run({ body: "$17.99/month, renews on 11/01/2026" }).payload.nextRenewalOn, "2026-11-01");
	const us = run({ from: "billing@vendor.us", fromName: "Vendor", body: "17,99 EUR monthly, renews on 11/01/2026" });
	assert.equal(us.payload.nextRenewalOn, "2026-11-01");
});

test("day arithmetic", () => {
	assert.equal(dates.addMonths("2026-01-31", 1), "2026-02-28");
	assert.equal(dates.addMonths("2026-11-30", 3), "2027-02-28");
	assert.equal(dates.addDays("2026-12-30", 3), "2027-01-02");
	assert.equal(dates.daysBetween("2026-09-14", "2026-10-14"), 30);
	assert.equal(dates.dayInTimeZone("2026-10-14T23:30:00Z", "Europe/Amsterdam"), "2026-10-15");
	assert.equal(dates.dayInTimeZone("2026-10-14T23:30:00Z", "Not/AZone"), "2026-10-14");
	assert.equal(dates.isDayString("2026-02-28"), true);
	assert.equal(dates.isDayString("2026-02-30"), false);
	assert.equal(dates.isDayString("20261101"), false);
});

// Cycles

test("cycle phrases in five languages", () => {
	const cases = {
		monthly: [
			"$5/month",
			"$5 /mo",
			"$5 per month",
			"monthly",
			"€5 per maand",
			"5 € monatlich",
			"5 € par mois",
			"5 € al mes",
			"5 €/Monat",
		],
		yearly: ["$50/yr", "$50 per year", "billed annually", "jaarlijks", "jährlich", "50 €/an", "por año"],
		quarterly: ["every 3 months", "quarterly", "per kwartaal", "trimestriel", "trimestral"],
		weekly: ["$2/week", "weekly", "wekelijks", "wöchentlich", "hebdomadaire", "semanal"],
	};
	for (const [cycle, phrases] of Object.entries(cases))
		for (const phrase of phrases) assert.equal(detect.findCycle(phrase, null), cycle, phrase);
	assert.equal(detect.findCycle("Thanks for being with us", null), null);
	assert.equal(detect.findCycle("Yearly plans exist. You pay monthly", "You pay $5 monthly"), "monthly");
	assert.equal(detect.findCycle("weekly digest; billed monthly", null), "weekly");
});

test("cycles inferred from intervals", () => {
	assert.equal(detect.cycleFromInterval(7), "weekly");
	assert.equal(detect.cycleFromInterval(30), "monthly");
	assert.equal(detect.cycleFromInterval(91), "quarterly");
	assert.equal(detect.cycleFromInterval(365), "yearly");
	assert.equal(detect.cycleFromInterval(14), null);
	assert.equal(detect.cycleFromInterval(200), null);
	assert.equal(detect.nextAfter("2026-10-14", "weekly"), "2026-10-21");
	assert.equal(detect.nextAfter("2026-10-14", "quarterly"), "2027-01-14");
	assert.equal(detect.nextAfter("2026-10-14", "yearly"), "2027-10-14");
});

// Vendors

test("vendor names lose sender noise and fall back to the domain", () => {
	assert.deepEqual(vendors.vendorName("Streamflix Billing", "billing@streamflix.example"), {
		vendor: "Streamflix",
		fromDomain: false,
	});
	assert.equal(vendors.vendorName('"Cloudbox Team"', "x@cloudbox.example").vendor, "Cloudbox");
	assert.equal(vendors.vendorName("Tunes via Paddle", "x@paddle.com").vendor, "Tunes");
	assert.equal(vendors.vendorName("Acme\u202e Payments\u200b", "x@acme.example").vendor, "Acme");
	assert.deepEqual(vendors.vendorName(null, "billing@mail.newsapp.co.uk"), { vendor: "Newsapp", fromDomain: true });
	assert.deepEqual(vendors.vendorName("billing@x.example", "billing@x.example"), { vendor: "X", fromDomain: true });
	assert.equal(vendors.vendorName("A".repeat(200), "x@a.example").vendor.length, 80);
});

test("vendor keys use the registrable domain, and processors add the vendor", () => {
	assert.equal(vendors.vendorKey("Billing <billing@mail.streamflix.example>", "Streamflix"), "streamflix.example");
	assert.equal(vendors.vendorKey("billing@news.example.co.uk", "News"), "example.co.uk");
	assert.equal(vendors.vendorKey("billing@shop.example.com.au", "Shop"), "example.com.au");
	assert.equal(vendors.vendorKey("no-reply@apple.com", "Tune Box Pro"), "apple.com:tune-box-pro");
	assert.equal(vendors.vendorKey("receipts@stripe.com", "Cloud Desk"), "stripe.com:cloud-desk");
	assert.equal(vendors.vendorKey("receipts@stripe.com", "***"), "stripe.com");
	assert.equal(vendors.vendorKey("nobody", "X"), null);
	assert.equal(vendors.registrableDomain("example"), "example");
	assert.equal(vendors.senderUsesUsDomain("a@shop.us"), true);
});

// Signals, threshold and events

test("an automatic monthly invoice is a new subscription card", () => {
	const detection = run({
		headers: {
			listUnsubscribe: "<https://streamflix.example/cancel>",
			listUnsubscribePost: "List-Unsubscribe=One-Click",
		},
	});
	assert.equal(detection.reason, "subscription");
	assert.deepEqual(detection.payload, {
		event: "new",
		subscriptionId: null,
		vendor: "Streamflix",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 1799,
		currency: "USD",
		previousAmountMinor: null,
		cycle: "monthly",
		nextRenewalOn: "2026-11-01",
		renewalEstimated: false,
		trialEndsOn: null,
		cancelLink: { url: "https://streamflix.example/cancel", oneClick: true },
		document: {
			docType: "invoice",
			documentOn: "2026-10-14",
			periodStartOn: null,
			periodEndOn: null,
			attachmentId: null,
		},
		unverified: false,
		signals: ["subject_keyword", "billing_sender", "amount", "cycle", "renewal_date", "doc_invoice"],
		modelFields: [],
		modelDisagrees: [],
	});
	assert.equal(text.suggestionTitle(detection.payload, "en"), "Streamflix $17.99/month, renews 1 Nov. Track it?");
});

test("one-off receipts, personal mentions of money and weak evidence give nothing", () => {
	assert.equal(run({ subject: "Your receipt", body: "You paid $42.00 for a desk lamp." }), null);
	assert.equal(
		run({ from: "sam@friends.example", fromName: "Sam", subject: "Dinner", body: "You owe me $20 for dinner" }),
		null,
	);
	// An amount and a cycle, but weight 3 < 4: no keyword, no billing sender.
	assert.equal(
		run({ from: "sam@friends.example", fromName: "Sam", subject: "Hi", body: "Gym is $20 per month" }),
		null,
	);
	// A cycle and a keyword but no amount.
	assert.equal(run({ body: "Your monthly plan renews on 1 Nov 2026." }), null);
	assert.equal(detect.signalWeight(["subject_keyword", "billing_sender", "amount"]), 3);
	assert.equal(detect.CANDIDATE_WEIGHT, 4);
});

test("phishing and spam are skipped", () => {
	assert.equal(detect.skipsMessage({ phishing: ["lookalike_domain"], spam: false }), true);
	assert.equal(detect.skipsMessage({ phishing: [], spam: true }), true);
	assert.equal(detect.skipsMessage({ phishing: [], spam: false }), false);
});

test("trial notices and an unauthenticated sender", () => {
	const detection = run({
		subject: "Your free trial",
		body: "Your trial ends on 1 Nov 2026. Then $9.99/month.",
		facts: { authPassed: false },
	});
	assert.equal(detection.payload.event, "trial");
	assert.equal(detection.payload.unverified, true);
	assert.equal(detection.reason, "subscription_trial");
	assert.equal(text.suggestionTitle(detection.payload, "en"), "Streamflix trial ends 1 Nov. Track it?");
});

test("an attachment and the model's receipt category add weight", () => {
	const attachments = [{ id: "a1", contentType: "application/pdf", filename: "invoice-10.pdf", size: 900 }];
	const detection = run({
		from: "hello@tools.example",
		fromName: "Tools",
		subject: "October",
		body: "$5/month",
		attachments,
		model: { category: "receipt" },
	});
	assert.ok(detection.payload.signals.includes("invoice_attachment"));
	assert.ok(detection.payload.signals.includes("model_receipt"));
	assert.equal(detection.payload.document.attachmentId, "a1");
});

test("a recurring sender and amount completes a receipt without a cycle", () => {
	const input = stepInput({ subject: "Your receipt", body: "Amount paid: $12.00" });
	const analysis = detect.analyzeMessage(input, "UTC");
	assert.equal(detect.needsHistory(analysis), true);
	assert.equal(detect.buildDetection(analysis, { tracked: null, recurring: null }), null);
	const history = [
		{ receivedAt: "2026-09-14T09:00:00Z", subject: "Your receipt", textExcerpt: "Amount paid: $12.00" },
		{ receivedAt: "2026-09-01T09:00:00Z", subject: "Other", textExcerpt: "Amount paid: $99.00" },
		{ receivedAt: "2026-08-15T09:00:00Z", subject: "Your receipt", textExcerpt: "Amount paid: $12.00" },
	];
	const cycle = detect.recurringCycle(analysis, history, "UTC");
	assert.equal(cycle, "monthly");
	const detection = detect.buildDetection(analysis, { tracked: null, recurring: cycle });
	assert.equal(detection.payload.cycle, "monthly");
	assert.ok(detection.payload.signals.includes("recurring"));
	assert.equal(detection.payload.renewalEstimated, true);
	assert.equal(detection.payload.document.docType, "payment");
	assert.equal(detect.recurringCycle(analysis, [history[1]], "UTC"), null);
	assert.equal(detect.recurringCycle(analysis, [{ ...history[0], receivedAt: "2026-10-01T09:00:00Z" }], "UTC"), null);
	// The first plausible interval may be between two older matches.
	const spaced = [
		{ ...history[0], receivedAt: "2026-10-01T09:00:00Z" },
		{ ...history[0], receivedAt: "2026-07-02T09:00:00Z" },
	];
	assert.equal(detect.recurringCycle(analysis, spaced, "UTC"), "quarterly");
	assert.equal(detect.needsHistory(detect.analyzeMessage(stepInput(), "UTC")), false);
	const noAmount = detect.analyzeMessage(stepInput({ body: "Thanks" }), "UTC");
	assert.equal(detect.recurringCycle(noAmount, history, "UTC"), null);
});

test("credits, refunds and failed payments from an untracked vendor give no card", () => {
	assert.equal(
		run({ subject: "Your refund", body: "Your refund of $19.99 has been issued. Plan $19.99/month." }),
		null,
	);
	assert.equal(run({ subject: "Credit note", body: "Credit note for $5.00, monthly plan" }), null);
	assert.equal(
		run({ subject: "Payment failed", body: "We were unable to process your payment of $17.99/month." }),
		null,
	);
});

test("a tracked vendor's refund is a refund event, never a price change", () => {
	const detection = run(
		{ subject: "Your refund", body: "Your refund of $19.99 has been issued." },
		{ tracked: tracked(), recurring: null },
	);
	assert.equal(detection.payload.event, "refund");
	assert.equal(detection.payload.previousAmountMinor, null);
	assert.equal(detection.payload.subscriptionId, "sub-1");
	assert.equal(detection.reason, "subscription_refund");
	assert.equal(text.suggestionTitle(detection.payload, "en"), "Streamflix refunded $19.99. Record it?");
	const credit = run(
		{ subject: "Credit note", body: "Credit note for $5.00" },
		{ tracked: tracked(), recurring: null },
	);
	assert.equal(text.suggestionTitle(credit.payload, "en"), "Streamflix credit note for $5.00. Record it?");
});

test("a tracked vendor's failed payment needs no amount", () => {
	const detection = run(
		{ subject: "Action needed", body: "Your payment failed. Please update your payment method." },
		{ tracked: tracked(), recurring: null },
	);
	assert.equal(detection.payload.event, "payment_failed");
	assert.equal(detection.payload.document.docType, "failed_payment");
	assert.ok(detection.payload.signals.includes("payment_failed"));
	assert.equal(text.suggestionTitle(detection.payload, "en"), "Streamflix payment failed. Mark it urgent?");
});

test("a tracked vendor's invoice is a renewal or a price change", () => {
	const renewal = run({ body: "$17.99/month, renews on 1 Dec 2026" }, { tracked: tracked(), recurring: null });
	assert.equal(renewal.payload.event, "renewal");
	assert.equal(text.suggestionTitle(renewal.payload, "en"), "Streamflix renewed, next on 1 Dec. Update it?");
	const change = run({ body: "$19.99/month, renews on 1 Dec 2026" }, { tracked: tracked(), recurring: null });
	assert.deepEqual([change.payload.event, change.payload.previousAmountMinor], ["price_change", 1799]);
	assert.equal(change.reason, "subscription_price_change");
	assert.equal(text.suggestionTitle(change.payload, "en"), "Streamflix now $19.99/month, up from $17.99. Update it?");
	const cheaper = run({ body: "$9.99/month" }, { tracked: tracked(), recurring: null });
	assert.equal(text.suggestionTitle(cheaper.payload, "en"), "Streamflix now $9.99/month, down from $17.99. Update it?");
	const trial = run(
		{ body: "$9.99/month after your trial ends 1 Nov 2026" },
		{ tracked: tracked({ amountMinor: null }), recurring: null },
	);
	assert.equal(trial.payload.event, "trial");
	// A tracked row only adds the recurring signal; without an amount there is still no card.
	assert.equal(run({ body: "Your monthly plan renews soon" }, { tracked: tracked(), recurring: null }), null);
	// The tracked row's cycle fills a gap.
	const noCycle = run(
		{ subject: "Your receipt", body: "Amount paid: $17.99" },
		{ tracked: tracked(), recurring: null },
	);
	assert.deepEqual([noCycle.payload.cycle, noCycle.payload.renewalEstimated], ["monthly", true]);
});

test("matching prefers the same currency, then plan, then the closest amount", () => {
	const analysis = detect.analyzeMessage(stepInput({ body: "Plan: Family\n$19.99/month" }), "UTC");
	const rows = [
		tracked({ id: "eur", currency: "EUR", amountMinor: 1999 }),
		tracked({ id: "far", amountMinor: 100 }),
		tracked({ id: "near", amountMinor: 1900 }),
		tracked({ id: "plan", plan: "Family", amountMinor: 500 }),
		tracked({ id: "other", vendorKey: "other.example" }),
	];
	assert.equal(detect.matchTracked(rows, analysis).id, "plan");
	assert.equal(
		detect.matchTracked(
			rows.filter((row) => row.id !== "plan"),
			analysis,
		).id,
		"near",
	);
	assert.equal(detect.matchTracked([rows[0], { ...rows[1], amountMinor: null }], analysis).id, "far");
	assert.equal(detect.matchTracked([rows[4]], analysis), null);
	assert.equal(analysis.plan, "Family");
});

test("plans come from a label or sit between the vendor and the amount", () => {
	const plan = (body) => detect.analyzeMessage(stepInput({ body }), "UTC").plan;
	assert.equal(plan("Subscription: Premium HD - billed monthly"), "Premium HD");
	assert.equal(plan("Streamflix Premium $17.99/month"), "Premium");
	assert.equal(plan("Charged $17.99/month"), null);
	assert.equal(plan("Thanks"), null);
});

test("titles omit unknown parts and stay within 120 characters", () => {
	const base = run().payload;
	assert.equal(text.suggestionTitle({ ...base, nextRenewalOn: null }, "en"), "Streamflix $17.99/month. Track it?");
	assert.equal(
		text.suggestionTitle({ ...base, cycle: null, nextRenewalOn: null }, "en"),
		"Streamflix $17.99. Track it?",
	);
	assert.equal(
		text.suggestionTitle({ ...base, event: "renewal", nextRenewalOn: null }, "en"),
		"Streamflix renewed. Update it?",
	);
	assert.equal(
		text.suggestionTitle({ ...base, event: "trial", trialEndsOn: null }, "en"),
		"Streamflix trial. Track it?",
	);
	const long = text.suggestionTitle({ ...base, vendor: "V".repeat(80), plan: null }, "en");
	assert.ok(long.length <= 120);
	assert.equal(
		text.suggestionTitle(
			{ ...base, vendor: "V".repeat(80), event: "price_change", previousAmountMinor: 1499, cycle: "quarterly" },
			"en",
		).length,
		120,
	);
	assert.equal(text.priceText({ amountMinor: null, currency: null, cycle: "monthly" }, "en"), null);
	assert.equal(text.shortDay("2026-11-01"), "1 Nov");
});

test("the card line names what Track also records", () => {
	const payload = run().payload;
	assert.equal(text.documentLine(payload, "en"), "Records this invoice of $17.99, 14 Oct");
	assert.equal(text.documentLine({ ...payload, event: "refund" }, "en"), null);
	assert.equal(text.documentLine({ ...payload, document: null }, "en"), null);
	assert.equal(
		text.documentLine({ ...payload, document: { ...payload.document, docType: "failed_payment" } }, "en"),
		null,
	);
	assert.equal(
		text.documentLine({ ...payload, amountMinor: null, document: { ...payload.document, docType: "credit" } }, "en"),
		"Records this credit note, 14 Oct",
	);
});

test("hostile inputs stay bounded and never become links or far dates", () => {
	const hostile = run({
		fromName: "\u202eNetfl\u0000ix\u200b Billing",
		body: `Your invoice: $17.99/month, renews on 1 Nov 9999. Cancel at https://evil.example/steal\n${"$".repeat(5000)}`,
	});
	assert.equal(hostile.payload.vendor, "Netflix");
	assert.equal(hostile.payload.cancelLink, null);
	assert.equal(hostile.payload.renewalEstimated, true);
	assert.equal(run({ body: "Your invoice: $99,999,999,999.00/month, renews 1 Nov 2026" }), null);
	assert.equal(run({ from: "billing@", fromName: "X" }), null);
	const nested = "1".repeat(4000) + "x";
	const start = Date.now();
	run({ body: `${nested} ${"1,".repeat(3000)}$ monthly` });
	assert.ok(Date.now() - start < 500);
});

test("the body or an http header never sets the cancel link", () => {
	assert.equal(
		run({ body: "Your invoice: $17.99/month. Cancel: https://streamflix.example/cancel" }).payload.cancelLink,
		null,
	);
	assert.equal(run({ headers: { listUnsubscribe: "<http://streamflix.example/cancel>" } }).payload.cancelLink, null);
	assert.equal(run({ headers: { listUnsubscribe: "<mailto:leave@streamflix.example>" } }).payload.cancelLink, null);
});

test("a labelled plan stops at its price and keeps its own digits", () => {
	const plan = (body) => detect.analyzeMessage(stepInput({ body }), "UTC").plan;
	assert.equal(plan("Plan: Premium $17.99/month, renews on 1 Nov 2026"), "Premium");
	assert.equal(plan("Plan: Plus 2TB 9,99 EUR monthly"), "Plus 2TB");
	assert.equal(plan("Plan: Family EUR 9.99 per month"), "Family");
});

test("renewal phrases name the next renewal in five languages", () => {
	const renewal = (body) => run({ body: `€9.99 per month. ${body}` }).payload.nextRenewalOn;
	assert.equal(renewal("Next renewal 3 Nov 2026."), "2026-11-03");
	assert.equal(renewal("Volgende verlenging: 3 november 2026."), "2026-11-03");
	assert.equal(renewal("Nächste Verlängerung: 3. November 2026."), "2026-11-03");
	assert.equal(renewal("Prochain renouvellement : 3 novembre 2026."), "2026-11-03");
	assert.equal(renewal("Próxima renovación: 3 de noviembre de 2026."), "2026-11-03");
});
