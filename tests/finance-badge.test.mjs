import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const { dueDay, badgeCount } = await loadFinance("badge-utils");

const TODAY = "2026-10-14";
const at = (day) => (day ? new Date(`${day}T00:00:00.000Z`) : null);
function row(extra = {}) {
	return {
		status: "active",
		nextRenewalAt: null,
		trialEndsAt: null,
		paymentFailedAt: null,
		reminderDays: 3,
		...extra,
	};
}

test("the due day is the trial end for a trial with one, otherwise the next renewal", () => {
	assert.equal(dueDay(row({ nextRenewalAt: at("2026-11-01") })), "2026-11-01");
	assert.equal(
		dueDay(row({ status: "trial", trialEndsAt: at("2026-10-20"), nextRenewalAt: at("2026-11-01") })),
		"2026-10-20",
	);
	assert.equal(dueDay(row({ status: "trial", nextRenewalAt: at("2026-11-01") })), "2026-11-01");
	assert.equal(dueDay(row({ trialEndsAt: at("2026-10-20"), nextRenewalAt: at("2026-11-01") })), "2026-11-01");
	assert.equal(dueDay(row()), null);
});

test("counts active and trial rows due today or later within their reminder window", () => {
	assert.equal(badgeCount([row({ nextRenewalAt: at(TODAY) })], TODAY), 1);
	assert.equal(badgeCount([row({ nextRenewalAt: at("2026-10-17") })], TODAY), 1);
	assert.equal(badgeCount([row({ nextRenewalAt: at("2026-10-18") })], TODAY), 0);
	assert.equal(badgeCount([row({ nextRenewalAt: at("2026-10-13") })], TODAY), 0);
	assert.equal(badgeCount([row({ reminderDays: 14, nextRenewalAt: at("2026-10-28") })], TODAY), 1);
	assert.equal(badgeCount([row({ status: "trial", trialEndsAt: at("2026-10-15") })], TODAY), 1);
	assert.equal(badgeCount([row()], TODAY), 0);
});

test("reminders turned off, cancelled and expired rows do not count", () => {
	assert.equal(badgeCount([row({ reminderDays: 0, nextRenewalAt: at(TODAY) })], TODAY), 0);
	assert.equal(badgeCount([row({ status: "cancelled", nextRenewalAt: at(TODAY) })], TODAY), 0);
	assert.equal(badgeCount([row({ status: "expired", nextRenewalAt: at(TODAY) })], TODAY), 0);
});

test("active rows with a failed payment count once, whatever their due date", () => {
	const failed = at("2026-10-01");
	assert.equal(badgeCount([row({ paymentFailedAt: failed })], TODAY), 1);
	assert.equal(badgeCount([row({ paymentFailedAt: failed, nextRenewalAt: at(TODAY) })], TODAY), 1);
	assert.equal(badgeCount([row({ status: "trial", paymentFailedAt: failed })], TODAY), 0);
	assert.equal(badgeCount([row({ status: "cancelled", paymentFailedAt: failed })], TODAY), 0);
});

test("sums over every row", () => {
	const rows = [
		row({ nextRenewalAt: at("2026-10-15") }),
		row({ paymentFailedAt: at("2026-10-01") }),
		row({ nextRenewalAt: at("2026-12-01") }),
		row({ status: "trial", trialEndsAt: at(TODAY) }),
	];
	assert.equal(badgeCount(rows, TODAY), 3);
	assert.equal(badgeCount([], TODAY), 0);
});
