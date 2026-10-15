import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const { monthlyCost, pairedDocumentIds, paidLast12Months, currencyTotals } = await loadFinance("totals-utils");

const TODAY = "2026-10-14";
let sequence = 0;
function entry(docType, amountMinor, documentOn, extra = {}) {
	sequence += 1;
	return {
		id: `doc-${String(sequence).padStart(3, "0")}`,
		subscriptionId: "sub-1",
		docType,
		amountMinor,
		currency: "USD",
		documentOn,
		periodStartOn: null,
		...extra,
	};
}
const paid = (entries, today = TODAY) => Object.fromEntries(paidLast12Months(entries, today));

test("monthly cost per cycle: weekly × 52 / 12, monthly, quarterly / 3, yearly / 12", () => {
	assert.equal(monthlyCost(1200, "monthly"), 1200);
	assert.equal(monthlyCost(1200, "weekly"), (1200 * 52) / 12);
	assert.equal(monthlyCost(3000, "quarterly"), 1000);
	assert.equal(monthlyCost(12000, "yearly"), 1000);
});

test("monthly and yearly totals per currency, with trials apart and inactive rows left out", () => {
	const rows = [
		{ status: "active", amountMinor: 1799, currency: "USD", cycle: "monthly" },
		{ status: "active", amountMinor: 12000, currency: "USD", cycle: "yearly" },
		{ status: "active", amountMinor: 500, currency: "EUR", cycle: "weekly" },
		{ status: "trial", amountMinor: 999, currency: "USD", cycle: "monthly" },
		{ status: "cancelled", amountMinor: 5000, currency: "USD", cycle: "monthly" },
		{ status: "expired", amountMinor: 5000, currency: "GBP", cycle: "monthly" },
		{ status: "active", amountMinor: null, currency: null, cycle: "monthly" },
		{ status: "active", amountMinor: 700, currency: "USD", cycle: null },
	];
	const totals = currencyTotals(rows, [entry("payment", 300, "2026-10-01", { currency: "CHF" })], TODAY);
	assert.deepEqual(totals, [
		{ currency: "CHF", monthlyMinor: 0, yearlyMinor: 0, trialMonthlyMinor: 0, paidLast12MonthsMinor: 300 },
		{
			currency: "EUR",
			monthlyMinor: Math.round((500 * 52) / 12),
			yearlyMinor: Math.round(((500 * 52) / 12) * 12),
			trialMonthlyMinor: 0,
			paidLast12MonthsMinor: 0,
		},
		{ currency: "USD", monthlyMinor: 2799, yearlyMinor: 33588, trialMonthlyMinor: 999, paidLast12MonthsMinor: 0 },
	]);
	assert.deepEqual(currencyTotals([], [], TODAY), []);
});

test("payments add, refunds subtract and failed payments never count", () => {
	assert.deepEqual(
		paid([
			entry("payment", 1799, "2026-09-01"),
			entry("payment", 1999, "2026-10-01"),
			entry("refund", 1999, "2026-10-05"),
			entry("failed_payment", null, "2026-10-10"),
			entry("failed_payment", 1999, "2026-10-11"),
		]),
		{ USD: 1799 },
	);
});

test("an invoice and its payment for the same stated period count once", () => {
	const period = { periodStartOn: "2026-09-01" };
	const invoice = entry("invoice", 1799, "2026-08-25", period);
	const payment = entry("payment", 1799, "2026-09-30", period);
	assert.deepEqual([...pairedDocumentIds([invoice, payment])], [invoice.id]);
	assert.deepEqual(paid([invoice, payment]), { USD: 1799 });
	const otherPeriod = entry("payment", 1799, "2026-08-26", { periodStartOn: "2026-10-01" });
	assert.deepEqual([...pairedDocumentIds([invoice, otherPeriod])], [], "stated periods that differ never pair");
});

test("without periods, equal amounts within 31 days pair and 32 days apart do not", () => {
	const invoice = entry("invoice", 1799, "2026-09-01");
	assert.deepEqual([...pairedDocumentIds([invoice, entry("payment", 1799, "2026-10-02")])], [invoice.id]);
	assert.deepEqual([...pairedDocumentIds([invoice, entry("payment", 1799, "2026-10-03")])], []);
	assert.deepEqual([...pairedDocumentIds([invoice, entry("payment", 1800, "2026-09-02")])], [], "amounts must match");
	assert.deepEqual(paid([invoice, entry("payment", 1799, "2026-10-03")]), { USD: 3598 });
});

test("one payment pairs with one invoice only, the nearest, ties to the older id", () => {
	const older = entry("invoice", 1799, "2026-09-01");
	const nearer = entry("invoice", 1799, "2026-09-09");
	const payment = entry("payment", 1799, "2026-09-10");
	assert.deepEqual([...pairedDocumentIds([older, nearer, payment])], [nearer.id]);
	assert.deepEqual(paid([older, nearer, payment]), { USD: 3598 });
	const first = entry("invoice", 1799, "2026-09-05");
	const second = entry("invoice", 1799, "2026-09-15");
	const between = entry("payment", 1799, "2026-09-10");
	assert.deepEqual([...pairedDocumentIds([second, first, between])], [first.id]);
	const later = entry("payment", 1799, "2026-09-16");
	assert.deepEqual([...pairedDocumentIds([first, second, between, later])].sort(), [first.id, second.id]);
});

test("an auto-charged invoice without a receipt counts", () => {
	assert.deepEqual(paid([entry("invoice", 1799, "2026-09-01"), entry("invoice", 1999, "2026-10-01")]), {
		USD: 3798,
	});
});

test("a credit and its refund pair the same way; an unsettled credit subtracts", () => {
	const credit = entry("credit", 500, "2026-09-01");
	const refund = entry("refund", 500, "2026-09-10");
	assert.deepEqual([...pairedDocumentIds([credit, refund])], [credit.id]);
	assert.deepEqual(paid([entry("payment", 1799, "2026-09-01"), credit, refund]), { USD: 1299 });
	assert.deepEqual(paid([entry("payment", 1799, "2026-09-01"), entry("credit", 500, "2026-09-02")]), { USD: 1299 });
	assert.deepEqual(
		[...pairedDocumentIds([entry("invoice", 500, "2026-09-01"), refund])],
		[],
		"a refund never pays an invoice",
	);
});

test("documents of another subscription or currency never pair", () => {
	const invoice = entry("invoice", 1799, "2026-09-01");
	assert.deepEqual(
		[...pairedDocumentIds([invoice, entry("payment", 1799, "2026-09-02", { subscriptionId: "sub-2" })])],
		[],
	);
	assert.deepEqual([...pairedDocumentIds([invoice, entry("payment", 1799, "2026-09-02", { currency: "EUR" })])], []);
});

test("the window runs from the same date 12 months ago, included, to today; tomorrow is excluded", () => {
	assert.deepEqual(
		paid([
			entry("payment", 100, "2025-10-14"),
			entry("payment", 200, "2025-10-13"),
			entry("payment", 400, "2026-10-14"),
			entry("payment", 800, "2026-10-15"),
		]),
		{ USD: 500 },
	);
	assert.deepEqual(paid([entry("payment", 100, "2025-02-28")], "2026-02-28"), { USD: 100 });
	// Pairing is decided before the window, so an invoice paid just inside it is not counted twice.
	const invoice = entry("invoice", 100, "2025-10-10");
	const payment = entry("payment", 100, "2025-10-20");
	assert.deepEqual(paid([invoice, payment]), { USD: 100 });
});

test("currencies are kept apart, cancelled subscriptions still count, and results may be negative", () => {
	assert.deepEqual(
		paid([
			entry("payment", 1799, "2026-09-01"),
			entry("payment", 1500, "2026-09-01", { currency: "EUR", subscriptionId: "sub-cancelled" }),
			entry("refund", 3000, "2026-10-01", { currency: "EUR", subscriptionId: "sub-cancelled" }),
			entry("payment", 900, "2026-09-01", { amountMinor: null }),
			entry("payment", 900, "2026-09-01", { currency: null }),
		]),
		{ USD: 1799, EUR: -1500 },
	);
});
