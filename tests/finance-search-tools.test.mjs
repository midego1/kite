import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const { containsPattern, searchSublabel } = await loadFinance("search-utils");
const { selectToolRows, toolSubscription, toolTotals } = await loadFinance("tool-utils");

const at = (day) => (day ? new Date(`${day}T00:00:00Z`) : null);

function row(overrides = {}) {
	return {
		id: "fsub_1",
		vendor: "Acmeflix",
		plan: null,
		amountMinor: 1799,
		currency: "USD",
		cycle: "monthly",
		status: "active",
		nextRenewalAt: at("2026-11-01"),
		trialEndsAt: null,
		paymentFailedAt: null,
		...overrides,
	};
}

test("containsPattern matches anywhere and takes %, _ and the escape character literally", () => {
	assert.equal(containsPattern("flix"), "%flix%");
	assert.equal(containsPattern("50%"), "%50\\%%");
	assert.equal(containsPattern("a_b"), "%a\\_b%");
	assert.equal(containsPattern("c\\d"), "%c\\\\d%");
});

test("searchSublabel names the plan and what is due, or the ended status", () => {
	assert.equal(searchSublabel(row()), "Renews 1 Nov");
	assert.equal(searchSublabel(row({ plan: "Family" })), "Family · Renews 1 Nov");
	assert.equal(searchSublabel(row({ status: "trial", trialEndsAt: at("2026-10-20") })), "Trial ends 20 Oct");
	assert.equal(searchSublabel(row({ status: "trial", nextRenewalAt: null })), "Trial");
	assert.equal(searchSublabel(row({ nextRenewalAt: null })), "Active");
	assert.equal(searchSublabel(row({ status: "cancelled", plan: "Basic" })), "Basic · Cancelled");
	assert.equal(searchSublabel(row({ status: "expired" })), "Expired");
	assert.equal(searchSublabel(row({ paymentFailedAt: at("2026-10-01") })), "Payment failed · Renews 1 Nov");
});

test("selectToolRows keeps current rows by default, filters by status and due window, and orders by due day", () => {
	const rows = [
		row({ id: "later", vendor: "Later", nextRenewalAt: at("2026-12-01") }),
		row({ id: "soon", vendor: "Soon", nextRenewalAt: at("2026-10-17") }),
		row({ id: "trial", vendor: "Trial", status: "trial", trialEndsAt: at("2026-10-16"), nextRenewalAt: null }),
		row({ id: "none", vendor: "Undated", nextRenewalAt: null }),
		row({ id: "gone", vendor: "Gone", status: "cancelled", nextRenewalAt: at("2026-10-16") }),
		row({ id: "past", vendor: "Past", nextRenewalAt: at("2026-10-01") }),
	];
	const ids = (input) => selectToolRows(rows, { limit: 20, ...input }, "2026-10-15").map((item) => item.id);
	assert.deepEqual(ids({}), ["past", "trial", "soon", "later", "none"]);
	assert.deepEqual(ids({ status: "all" }), ["past", "gone", "trial", "soon", "later", "none"]);
	assert.deepEqual(ids({ status: "cancelled" }), ["gone"]);
	assert.deepEqual(ids({ status: "trial" }), ["trial"]);
	assert.deepEqual(ids({ dueWithinDays: 2 }), ["trial", "soon"]);
	assert.deepEqual(ids({ dueWithinDays: 2, status: "all" }), ["trial", "soon"], "an ended row has nothing due");
	assert.deepEqual(ids({ limit: 2 }), ["past", "trial"]);
	const tied = [row({ id: "b", vendor: "beta" }), row({ id: "a", vendor: "Alpha" })];
	assert.deepEqual(
		selectToolRows(tied, { limit: 20 }, "2026-10-15").map((item) => item.id),
		["a", "b"],
	);
});

test("toolSubscription carries the ref, the price, the dates and urgency", () => {
	assert.deepEqual(toolSubscription(row({ plan: "Premium", paymentFailedAt: at("2026-10-02") })), {
		ref: { kind: "finance:subscription", id: "fsub_1" },
		vendor: "Acmeflix",
		plan: "Premium",
		amount: { minor: 1799, currency: "USD" },
		cycle: "monthly",
		status: "active",
		nextRenewalOn: "2026-11-01",
		trialEndsOn: null,
		urgent: true,
	});
	const bare = toolSubscription(row({ amountMinor: null, currency: null, cycle: null, nextRenewalAt: null }));
	assert.equal(bare.amount, null);
	assert.equal(bare.nextRenewalOn, null);
	assert.equal(bare.urgent, false);
});

test("toolTotals keeps the four tool fields, including a negative paid total", () => {
	assert.deepEqual(
		toolTotals([
			{ currency: "EUR", monthlyMinor: 0, yearlyMinor: 0, trialMonthlyMinor: 0, paidLast12MonthsMinor: -500 },
			{ currency: "USD", monthlyMinor: 1799, yearlyMinor: 21588, trialMonthlyMinor: 300, paidLast12MonthsMinor: 1799 },
		]),
		[
			{ currency: "EUR", monthlyMinor: 0, yearlyMinor: 0, paidLast12MonthsMinor: -500 },
			{ currency: "USD", monthlyMinor: 1799, yearlyMinor: 21588, paidLast12MonthsMinor: 1799 },
		],
	);
});
