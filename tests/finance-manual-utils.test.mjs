import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const { auditMailbox, editPlan, manualFields, draftFromAnalysis, NO_MAILBOX_ERROR } = await loadFinance("manual-utils");
const { subscriptionBodySchema, documentBodySchema, patchBodySchema, detectBodySchema, bodyError } =
	await loadFinance("api-schemas");
const { manualVendorKey } = await loadFinance("vendor-utils");
const { isCurrencyCode } = await loadFinance("amount-utils");

const TODAY = "2026-10-14";

function row(overrides = {}) {
	return {
		id: "fsub_1",
		userId: "owner",
		mailboxId: "mailbox-a",
		contactId: null,
		vendor: "Streamflix",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 1799,
		currency: "USD",
		cycle: "monthly",
		nextRenewalAt: new Date("2026-11-01T00:00:00.000Z"),
		renewalEstimated: true,
		trialEndsAt: null,
		status: "active",
		paymentFailedAt: null,
		reminderDays: 3,
		calendarReminder: true,
		lastRemindedFor: null,
		calendarEventId: null,
		cancelUrl: null,
		cancelOneClick: false,
		previousAmountMinor: null,
		priceChangedAt: null,
		sourceMessageId: null,
		lastMessageId: null,
		createdAt: new Date(1),
		updatedAt: new Date(1),
		...overrides,
	};
}

test("the audit mailbox is the row's while the owner manages it", () => {
	const managed = [
		{ id: "older", createdAt: new Date(1) },
		{ id: "mailbox-a", createdAt: new Date(5) },
	];
	assert.equal(auditMailbox("mailbox-a", managed), "mailbox-a");
});

test("the audit mailbox falls back to the owner's oldest managed mailbox", () => {
	const managed = [
		{ id: "newer", createdAt: new Date(9) },
		{ id: "oldest", createdAt: new Date(2) },
		{ id: "middle", createdAt: 5 },
	];
	assert.equal(auditMailbox("lost-access", managed), "oldest");
	assert.equal(auditMailbox(null, managed), "oldest");
	assert.equal(
		auditMailbox(null, [
			{ id: "b", createdAt: null },
			{ id: "a", createdAt: null },
		]),
		"a",
		"ties go to the lower id",
	);
});

test("without a managed mailbox there is no audit mailbox", () => {
	assert.equal(auditMailbox("mailbox-a", []), null);
	assert.equal(auditMailbox(null, []), null);
	assert.equal(NO_MAILBOX_ERROR, "Money Watch needs a mailbox you manage to record changes");
});

test("manual rows take the dialog's fields and the message's cancel link only", () => {
	const fields = manualFields(
		{ vendor: "Gym", plan: "", amountMinor: 2500, currency: "EUR", cycle: "monthly", reminderDays: 7 },
		{ cancelLink: { url: "https://gym.example/stop", oneClick: true }, messageId: "msg-1" },
	);
	assert.deepEqual(
		{
			plan: fields.plan,
			amount: [fields.amountMinor, fields.currency],
			status: fields.status,
			reminder: [fields.reminderDays, fields.calendarReminder],
			cancel: [fields.cancelUrl, fields.cancelOneClick],
			lastMessageId: fields.lastMessageId,
			renewalEstimated: fields.renewalEstimated,
		},
		{
			plan: null,
			amount: [2500, "EUR"],
			status: "active",
			reminder: [7, true],
			cancel: ["https://gym.example/stop", true],
			lastMessageId: "msg-1",
			renewalEstimated: false,
		},
	);
	const trial = manualFields(
		{ vendor: "Gym", trialEndsOn: "2026-11-01", currency: "EUR" },
		{ cancelLink: null, messageId: null },
	);
	assert.equal(trial.status, "trial");
	assert.equal(trial.currency, null, "no amount, no currency");
	assert.equal(trial.cancelUrl, null);
	assert.equal(
		manualFields({ vendor: "Gym", status: "cancelled" }, { cancelLink: null, messageId: null }).status,
		"cancelled",
	);
});

test("edit plans: fields, reminder and status, each with what undo restores", () => {
	const edit = editPlan({ fields: { amountMinor: 1999, nextRenewalOn: "2026-12-01", plan: "" } }, row());
	assert.equal(edit.capability, "editSubscription");
	assert.equal(edit.variant, "");
	assert.deepEqual(edit.input.changes, {
		amountMinor: 1999,
		nextRenewalOn: "2026-12-01",
		plan: null,
		renewalEstimated: false,
	});
	assert.deepEqual(edit.input.previous, {
		amountMinor: 1799,
		nextRenewalOn: "2026-11-01",
		plan: null,
		renewalEstimated: true,
	});
	const cleared = editPlan({ fields: { amountMinor: null } }, row());
	assert.deepEqual(cleared.input.changes, { amountMinor: null, currency: null });

	const reminder = editPlan({ reminderDays: 7 }, row());
	assert.deepEqual(
		[reminder.capability, reminder.variant, reminder.input.changes, reminder.input.previous],
		["editSubscription", "reminder", { reminderDays: 7 }, { reminderDays: 3 }],
	);
	const calendar = editPlan({ calendarReminder: false }, row());
	assert.deepEqual(calendar.input.changes, { calendarReminder: false });

	const status = editPlan({ status: "cancelled" }, row());
	assert.deepEqual(
		[status.capability, status.variant, status.input.previous],
		["setSubscriptionStatus", "cancelled", { status: "active" }],
	);
});

test("an edit may not leave an amount without a currency", () => {
	assert.match(
		editPlan({ fields: { amountMinor: 500 } }, row({ amountMinor: null, currency: null })).error,
		/currency/,
	);
	assert.match(editPlan({ fields: { currency: null } }, row()).error, /currency/);
	assert.equal(editPlan({ fields: { amountMinor: 500 } }, row()).variant, "");
	assert.equal(editPlan({ fields: { currency: null } }, row({ amountMinor: null, currency: null })).variant, "");
});

function analysis(overrides = {}) {
	return {
		vendor: "Streamflix",
		vendorFromDomain: false,
		vendorKey: "streamflix.example",
		plan: "Premium",
		amount: { minor: 1799, currency: "USD" },
		cycle: null,
		renewalOn: null,
		trialEndsOn: null,
		paymentFailed: false,
		document: {
			docType: "payment",
			documentOn: "2026-10-10",
			periodStartOn: null,
			periodEndOn: null,
			attachmentId: "att-1",
			confident: true,
		},
		cancelLink: { url: "https://streamflix.example/cancel", oneClick: false },
		unverified: false,
		signals: new Set(),
		dates: { messageDay: "2026-10-10", monthFirst: true },
		...overrides,
	};
}

test("the draft carries what the detector read and the cycle the context implies", () => {
	const draft = draftFromAnalysis(analysis(), { tracked: null, recurring: "monthly" });
	assert.deepEqual(draft, {
		vendor: "Streamflix",
		vendorKey: "streamflix.example",
		plan: "Premium",
		amountMinor: 1799,
		currency: "USD",
		cycle: "monthly",
		nextRenewalOn: "2026-11-10",
		renewalEstimated: true,
		trialEndsOn: null,
		cancelLink: { url: "https://streamflix.example/cancel", oneClick: false },
		document: {
			docType: "payment",
			amountMinor: 1799,
			currency: "USD",
			documentOn: "2026-10-10",
			periodStartOn: null,
			periodEndOn: null,
			attachmentId: "att-1",
		},
		subscriptionId: null,
	});
	const tracked = {
		id: "fsub_9",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 1799,
		currency: "USD",
		cycle: "yearly",
	};
	const matched = draftFromAnalysis(analysis({ renewalOn: "2026-12-01" }), { tracked, recurring: null });
	assert.deepEqual(
		[matched.subscriptionId, matched.cycle, matched.nextRenewalOn, matched.renewalEstimated],
		["fsub_9", "yearly", "2026-12-01", false],
	);
	const bare = draftFromAnalysis(analysis({ amount: null, document: null }), { tracked: null, recurring: null });
	assert.deepEqual([bare.cycle, bare.nextRenewalOn, bare.document, bare.currency], [null, null, null, null]);
	const failed = draftFromAnalysis(analysis({ document: { ...analysis().document, docType: "failed_payment" } }), {
		tracked: null,
		recurring: null,
	});
	assert.equal(failed.document, null, "a failed payment is recorded only through its card");
});

test("manual vendor keys are slugs under manual:", () => {
	assert.equal(manualVendorKey("My Gym & Spa"), "manual:my-gym-spa");
	assert.equal(manualVendorKey("Café"), "manual:cafe");
	assert.equal(manualVendorKey("健身房"), "manual:subscription");
	assert.equal(isCurrencyCode("EUR"), true);
	assert.equal(isCurrencyCode("XXX"), false);
});

const subscription = subscriptionBodySchema(TODAY);
const invalid = (schema, body) => !schema.safeParse(body).success;

test("the add body is bounded like detection, with 5 years of history", () => {
	assert.ok(subscription.safeParse({ vendor: "Gym", amountMinor: 2500, currency: "EUR", cycle: "monthly" }).success);
	assert.ok(subscription.safeParse({ vendor: "Gym", nextRenewalOn: "2021-11-01" }).success, "5 years back is history");
	for (const body of [
		{ vendor: "Gym", amountMinor: 0, currency: "EUR" },
		{ vendor: "Gym", amountMinor: -5, currency: "EUR" },
		{ vendor: "Gym", amountMinor: 100_000_001, currency: "EUR" },
		{ vendor: "Gym", amountMinor: 12.5, currency: "EUR" },
		{ vendor: "Gym", amountMinor: 2500, currency: "XXX" },
		{ vendor: "Gym", amountMinor: 2500 },
		{ vendor: "Gym", amountMinor: 2500, currency: null },
		{ vendor: "Gym", cycle: "daily" },
		{ vendor: "Gym", nextRenewalOn: "2028-10-15" },
		{ vendor: "Gym", nextRenewalOn: "2021-10-13" },
		{ vendor: "Gym", trialEndsOn: "2026-02-30" },
		{ vendor: "Gym", reminderDays: 31 },
		{ vendor: "Gym", reminderDays: -1 },
		{ vendor: "x".repeat(81) },
		{ vendor: "   " },
		{ vendor: "Gym", plan: "p".repeat(81) },
		{ vendor: "Gym", cancelUrl: "https://gym.example/stop" },
		{ vendor: "Gym", document: { docType: "payment", amountMinor: 100, currency: "EUR", documentOn: TODAY } },
	])
		assert.ok(invalid(subscription, body), JSON.stringify(body));
	assert.ok(subscription.safeParse({ vendor: "Gym", nextRenewalOn: "2028-10-14" }).success, "exactly 2 years ahead");
});

test("the document body bounds the date, the period and the amount", () => {
	const documents = documentBodySchema(TODAY);
	const base = { messageId: "msg-1", docType: "payment", amountMinor: 1799, currency: "USD", documentOn: TODAY };
	assert.ok(documents.safeParse(base).success);
	assert.ok(documents.safeParse({ ...base, documentOn: "2026-10-15" }).success, "1 day ahead");
	assert.ok(
		documents.safeParse({ ...base, periodStartOn: "2026-01-01", periodEndOn: "2027-01-02" }).success,
		"366 days",
	);
	for (const body of [
		{ ...base, documentOn: "2026-10-16" },
		{ ...base, documentOn: "2021-10-13" },
		{ ...base, periodStartOn: "2026-01-01", periodEndOn: "2027-01-03" },
		{ ...base, periodStartOn: "2026-10-10", periodEndOn: "2026-10-01" },
		{ ...base, periodStartOn: "2026-10-10" },
		{ ...base, amountMinor: 0 },
		{ ...base, amountMinor: undefined },
		{ ...base, currency: "usd" },
		{ ...base, docType: "failed_payment" },
		{ ...base, messageId: undefined },
	])
		assert.ok(invalid(documents, body), JSON.stringify(body));
});

test("a PATCH is exactly one of an edit, a reminder change or a status", () => {
	const patch = patchBodySchema(TODAY);
	assert.ok(patch.safeParse({ fields: { vendor: "New" } }).success);
	assert.ok(patch.safeParse({ reminderDays: 7, calendarReminder: false }).success);
	assert.ok(patch.safeParse({ status: "expired" }).success);
	for (const body of [
		{},
		{ fields: {} },
		{ fields: { status: "active" } },
		{ fields: { amountMinor: 0 } },
		{ fields: { amountMinor: 100, currency: null } },
		{ reminderDays: 31 },
		{ status: "paused" },
		{ status: "active", reminderDays: 3 },
		{ fields: { vendor: "x" }, status: "active" },
		null,
	])
		assert.ok(invalid(patch, body), JSON.stringify(body));
	assert.ok(detectBodySchema.safeParse({ messageId: "m" }).success);
	assert.ok(invalid(detectBodySchema, { messageId: "" }));
});

test("body errors name the first field that failed", () => {
	const parsed = subscription.safeParse({ vendor: "Gym", reminderDays: 31 });
	assert.match(bodyError(parsed.error), /^reminderDays: /);
	assert.equal(bodyError({ issues: [] }), "Invalid request");
	assert.ok(!bodyError(detectBodySchema.safeParse(null).error).startsWith(":"));
});
