import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-subscriptions-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/finance/subscriptions-utils.ts")],
	outfile: join(outDir, "subscriptions-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const view = await import(pathToFileURL(join(outDir, "subscriptions-utils.mjs")).href);

const TODAY = "2026-10-15";

function item(overrides = {}) {
	return {
		id: "fsub_1",
		vendor: "Streamflix",
		plan: "Premium",
		amount: { minor: 1799, currency: "USD" },
		cycle: "monthly",
		status: "active",
		nextRenewalOn: "2026-11-01",
		renewalEstimated: false,
		trialEndsOn: null,
		urgent: false,
		reminderDays: 3,
		calendarReminder: true,
		cancelUrl: null,
		previousAmountMinor: null,
		priceChangedAt: null,
		lastMessageId: null,
		sourceMessageId: null,
		mailboxId: "mbx_1",
		...overrides,
	};
}

test("the due day is the trial end for a trial that has one, otherwise the next renewal", () => {
	const due = (overrides) => view.cancelBeforeText(item(overrides));
	assert.equal(due({}), "Cancel before 31 Oct");
	assert.equal(due({ status: "trial", trialEndsOn: "2026-10-20" }), "Cancel before 19 Oct");
	assert.equal(due({ status: "active", trialEndsOn: "2026-10-20" }), "Cancel before 31 Oct");
	assert.equal(due({ status: "trial", trialEndsOn: null }), "Cancel before 31 Oct");
	assert.equal(due({ nextRenewalOn: null }), "Cancel");
});

test("rows are grouped into needs attention, upcoming by due date, no date and ended", () => {
	const groups = view.groupSubscriptions(
		[
			item({ id: "later", vendor: "Later", nextRenewalOn: "2026-12-01" }),
			item({ id: "soon", vendor: "Soon", nextRenewalOn: "2026-10-20" }),
			item({ id: "same-b", vendor: "Beta", nextRenewalOn: "2026-10-25" }),
			item({ id: "same-a", vendor: "alpha", nextRenewalOn: "2026-10-25" }),
			item({ id: "failed", vendor: "Failed", urgent: true }),
			item({ id: "trial", vendor: "Trial", status: "trial", trialEndsOn: "2026-10-17", reminderDays: 3 }),
			item({ id: "trial-later", vendor: "Trial later", status: "trial", trialEndsOn: "2026-10-30" }),
			item({ id: "passed", vendor: "Passed", nextRenewalOn: "2026-10-10" }),
			item({ id: "nodate", vendor: "Nodate", nextRenewalOn: null }),
			item({ id: "cancelled", vendor: "Zed", status: "cancelled" }),
			item({ id: "expired", vendor: "Old", status: "expired", urgent: true }),
		],
		TODAY,
	);
	assert.deepEqual(
		groups.attention.map((entry) => [entry.item.id, entry.reason]),
		[
			["passed", "Renewal date passed"],
			["trial", "Trial ends in 2 days"],
			["failed", "Payment failed"],
		],
	);
	assert.deepEqual(
		groups.upcoming.map((entry) => entry.id),
		["soon", "same-a", "same-b", "trial-later", "later"],
	);
	assert.deepEqual(
		groups.noDate.map((entry) => entry.id),
		["nodate"],
	);
	assert.deepEqual(
		groups.ended.map((entry) => entry.id),
		["expired", "cancelled"],
	);
});

test("a trial with reminders off and a passed trial end are flagged the right way", () => {
	const groups = view.groupSubscriptions(
		[
			item({ id: "quiet", status: "trial", trialEndsOn: "2026-10-16", reminderDays: 0 }),
			item({ id: "ended", status: "trial", trialEndsOn: "2026-10-01" }),
			item({ id: "today", status: "trial", trialEndsOn: TODAY, reminderDays: 1 }),
		],
		TODAY,
	);
	assert.deepEqual(
		groups.attention.map((entry) => [entry.item.id, entry.reason]),
		[
			["ended", "Trial ended"],
			["today", "Trial ends today"],
		],
	);
	assert.deepEqual(
		groups.upcoming.map((entry) => entry.id),
		["quiet"],
	);
});

test("due texts name the day relative to today and the date", () => {
	assert.equal(view.dueText(item({ nextRenewalOn: "2026-10-20" }), TODAY), "renews in 5 days (20 Oct)");
	assert.equal(view.dueText(item({ nextRenewalOn: "2026-10-16" }), TODAY), "renews tomorrow (16 Oct)");
	assert.equal(view.dueText(item({ nextRenewalOn: TODAY }), TODAY), "renews today (15 Oct)");
	assert.equal(view.dueText(item({ nextRenewalOn: "2026-10-01" }), TODAY), "was due 1 Oct");
	assert.equal(
		view.dueText(item({ status: "trial", trialEndsOn: "2026-10-18" }), TODAY),
		"trial ends in 3 days (18 Oct)",
	);
	assert.equal(view.dueText(item({ nextRenewalOn: null }), TODAY), null);
});

test("Cancel before names the day before the due date", () => {
	assert.equal(view.cancelBeforeText(item({ nextRenewalOn: "2026-11-01" })), "Cancel before 31 Oct");
	assert.equal(view.cancelBeforeText(item({ nextRenewalOn: null })), "Cancel");
});

test("the price change chip shows for 90 days after the change", () => {
	const changed = item({ amount: { minor: 1999, currency: "USD" }, previousAmountMinor: 1799 });
	assert.equal(
		view.priceChangeChip({ ...changed, priceChangedAt: "2026-07-17T10:00:00.000Z" }, TODAY, "en-US"),
		"Increased from $17.99",
	);
	assert.equal(view.priceChangeChip({ ...changed, priceChangedAt: "2026-07-16T10:00:00.000Z" }, TODAY, "en-US"), null);
	assert.equal(
		view.priceChangeChip(
			{ ...changed, amount: { minor: 1499, currency: "USD" }, priceChangedAt: "2026-10-01T00:00:00.000Z" },
			TODAY,
			"en-US",
		),
		"Decreased from $17.99",
	);
	assert.equal(view.priceChangeChip(item({ priceChangedAt: "2026-10-01T00:00:00.000Z" }), TODAY, "en-US"), null);
	assert.equal(
		view.priceChangeChip({ ...changed, amount: null, priceChangedAt: "2026-10-01T00:00:00.000Z" }, TODAY, "en-US"),
		null,
	);
	assert.equal(view.priceChangeChip({ ...changed, priceChangedAt: null }, TODAY, "en-US"), null);
});

test("prices read as amount per cycle, or say there is none", () => {
	assert.equal(view.priceLabel(item(), "en-US"), "$17.99/month");
	assert.equal(view.priceLabel(item({ cycle: null }), "en-US"), "$17.99");
	assert.equal(view.priceLabel(item({ amount: null }), "en-US"), "No price");
});

test("cost lines are per currency with yearly totals and what trials add", () => {
	const lines = view.costLines(
		[
			{ currency: "EUR", monthlyMinor: 1000, yearlyMinor: 12000, trialMonthlyMinor: 0, paidLast12MonthsMinor: 0 },
			{ currency: "GBP", monthlyMinor: 0, yearlyMinor: 0, trialMonthlyMinor: 0, paidLast12MonthsMinor: 500 },
			{ currency: "USD", monthlyMinor: 3966, yearlyMinor: 47588, trialMonthlyMinor: 500, paidLast12MonthsMinor: 3798 },
		],
		"en-US",
	);
	assert.deepEqual(lines, [
		{ currency: "EUR", monthly: "€10.00/month", yearly: "€120.00/year", trial: null },
		{ currency: "USD", monthly: "$39.66/month", yearly: "$475.88/year", trial: "after trials: +$5.00/month" },
	]);
});

test("paid lines skip currencies with nothing paid and keep negative totals", () => {
	assert.deepEqual(
		view.paidLines(
			[
				{ currency: "EUR", minor: 0 },
				{ currency: "USD", minor: 3798 },
				{ currency: "GBP", minor: -500 },
			],
			"en-US",
		),
		[
			{ currency: "USD", text: "$37.98" },
			{ currency: "GBP", text: "-£5.00" },
		],
	);
});

test("rows without an amount or a cycle are counted as without a price, ended rows are not", () => {
	assert.equal(
		view.unpricedCount([
			item(),
			item({ amount: null }),
			item({ cycle: null, status: "trial" }),
			item({ amount: null, status: "cancelled" }),
		]),
		2,
	);
});

test("documents are labelled and credits and refunds are negative", () => {
	assert.equal(view.documentLabel("invoice"), "Invoice");
	assert.equal(view.documentLabel("credit"), "Credit note");
	assert.equal(view.documentLabel("failed_payment"), "Payment failed");
	const doc = (overrides) => ({ docType: "refund", amount: { minor: 1999, currency: "USD" }, ...overrides });
	assert.equal(view.documentAmount(doc(), "en-US"), "−$19.99");
	assert.equal(view.documentAmount(doc({ docType: "credit" }), "en-US"), "−$19.99");
	assert.equal(view.documentAmount(doc({ docType: "payment" }), "en-US"), "$19.99");
	assert.equal(view.documentAmount(doc({ amount: null }), "en-US"), null);
	assert.equal(view.pairedLabel(doc({ docType: "invoice", paired: true })), "Paid");
	assert.equal(view.pairedLabel(doc({ docType: "credit", paired: true })), "Refunded");
	assert.equal(view.pairedLabel(doc({ docType: "invoice", paired: false })), null);
	assert.equal(view.periodText("2026-10-01", "2026-10-31"), "1 Oct – 31 Oct");
	assert.equal(view.periodText(null, null), null);
});

test("document links need an available message, and the document link an attachment", () => {
	const message = { kind: "mail:message", id: "msg 1", href: "/inbox/msg%201", label: "Invoice" };
	const doc = { messageId: "msg 1", attachmentId: "att/1", message };
	assert.equal(view.threadHref(doc), "/inbox/msg%201");
	assert.equal(view.documentHref(doc), "/api/messages/msg%201/attachments/att%2F1?preview=1");
	assert.equal(view.documentHref({ ...doc, attachmentId: null }), null);
	const gone = { ...doc, message: { kind: "mail:message", id: "msg 1", unavailable: true, label: "Message" } };
	assert.equal(view.threadHref(gone), null);
	assert.equal(view.documentHref(gone), null);
	assert.equal(view.messageGone(gone), true);
	assert.equal(view.messageGone({ ...doc, messageId: null, message: null }), true);
	assert.equal(view.messageGone(doc), false);
	assert.equal(view.threadHref({ ...doc, message: { ...message, href: "https://elsewhere.example/" } }), null);
});

test("the latest message link prefers the last message", () => {
	assert.equal(view.latestMessageHref(item({ lastMessageId: "m2", sourceMessageId: "m1" })), "/inbox/m2");
	assert.equal(view.latestMessageHref(item({ sourceMessageId: "m1" })), "/inbox/m1");
	assert.equal(view.latestMessageHref(item()), null);
});

test("status and reminder labels and choices", () => {
	assert.equal(view.statusLabel("trial"), "Trial");
	assert.deepEqual(
		view.statusChoices("active").map((choice) => choice.status),
		["cancelled", "expired", "trial"],
	);
	assert.deepEqual(
		view.statusChoices("cancelled").map((choice) => choice.label),
		["Mark as active", "Mark as expired", "Mark as trial"],
	);
	assert.deepEqual(view.REMINDER_DAYS, [0, 1, 3, 7, 14]);
	assert.equal(view.reminderLabel(0), "Off");
	assert.equal(view.reminderLabel(1), "1 day before");
	assert.equal(view.reminderLabel(7), "7 days before");
	assert.equal(view.reminderToast(7), "Reminder set to 7 days before");
	assert.equal(view.reminderToast(0), "Reminder turned off");
});

test("the edit form starts from the row and sends only what changed", () => {
	const row = item({ trialEndsOn: "2026-10-20" });
	const form = view.formFromItem(row);
	assert.deepEqual(form, {
		vendor: "Streamflix",
		plan: "Premium",
		amount: "17.99",
		currency: "USD",
		cycle: "monthly",
		nextRenewalOn: "2026-11-01",
		trialEndsOn: "2026-10-20",
		reminderDays: "3",
		calendarReminder: true,
	});
	assert.deepEqual(view.formFromItem(item({ amount: null, plan: null, cycle: null, nextRenewalOn: null })), {
		...form,
		plan: "",
		amount: "",
		currency: "",
		cycle: "",
		nextRenewalOn: "",
		trialEndsOn: "",
	});
	assert.deepEqual(view.editChanges(form, row), { fields: {} });
	assert.deepEqual(view.editChanges({ ...form, amount: "19.99", plan: " " }, row), {
		fields: { plan: null, amountMinor: 1999 },
	});
	assert.deepEqual(view.editChanges({ ...form, amount: "", trialEndsOn: "" }, row), {
		fields: { amountMinor: null, currency: null, trialEndsOn: null },
	});
	assert.deepEqual(view.editChanges({ ...form, currency: "eur", cycle: "yearly" }, row), {
		fields: { currency: "EUR", cycle: "yearly" },
	});
	assert.deepEqual(view.editChanges({ ...form, vendor: "" }, row), { error: "Enter the vendor" });
	assert.deepEqual(view.editChanges({ ...form, amount: "abc" }, row), { error: "Enter the amount, like 17.99" });
});

test("the add body names the mailbox and no message", () => {
	const form = view.formFromItem(item());
	const built = view.addBody(form, "mbx_9");
	assert.equal(built.body.mailboxId, "mbx_9");
	assert.equal(built.body.messageId, null);
	assert.equal(built.body.amountMinor, 1799);
	assert.deepEqual(view.addBody({ ...form, vendor: " " }, "mbx_9"), { error: "Enter the vendor" });
});

test("the status filter keeps the sections it names", () => {
	assert.deepEqual(view.visibleSections("current"), { current: true, ended: false });
	assert.deepEqual(view.visibleSections("ended"), { current: false, ended: true });
	assert.deepEqual(view.visibleSections("all"), { current: true, ended: true });
});
