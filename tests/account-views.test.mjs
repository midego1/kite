import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// The sidebar's connected-account views (docs/external-accounts.md#connected-account-views): which accounts are
// listed, what each entry searches for and when its view counts as open.

const {
	parseAccountViews,
	accountViewsIn,
	accountViewHref,
	activeAccountView,
	openViewName,
	isAccountOutside,
	viaSearchQuery,
	parseSearchQuery,
} = await bundleModules("kite-account-views-", [
	[
		"parseAccountViews, accountViewsIn, accountViewHref, activeAccountView, openViewName, isAccountOutside",
		"src/lib/external-accounts/account-views-utils.ts",
	],
	["viaSearchQuery", "src/lib/external-accounts/via-utils.ts"],
	["parseSearchQuery", "src/lib/search/query-utils.ts"],
]);

const account = (overrides = {}) => ({
	id: "acc-1",
	mailboxId: "box-1",
	label: "demo@gmail.example",
	address: "demo@gmail.example",
	preset: "gmail",
	...overrides,
});

test("an account becomes a view named by its label, or its provider while the label is still the address", () => {
	const [plain, renamed, other] = parseAccountViews({
		accounts: [
			account(),
			account({ id: "acc-2", label: "Work mail", address: "work@gmail.example" }),
			account({ id: "acc-3", address: "me@example.org", label: "me@example.org", preset: "other" }),
		],
	});
	assert.deepEqual(plain, { id: "acc-1", mailboxId: "box-1", label: "Gmail", address: "demo@gmail.example" });
	assert.equal(renamed.label, "Work mail");
	assert.equal(other.label, "example.org");
});

test("anything that is not a usable account is left out", () => {
	for (const value of [null, "x", [], {}, { accounts: "none" }, { accounts: [null, 3, {}, { id: "a" }] }])
		assert.deepEqual(parseAccountViews(value), []);
	assert.deepEqual(parseAccountViews({ accounts: [account({ address: "" }), account({ mailboxId: 4 })] }), []);
});

test("an entry opens the Inbox with its address, and the filter the list runs is the via: search", () => {
	const [entry] = parseAccountViews({ accounts: [account()] });
	assert.equal(parseSearchQuery(viaSearchQuery(entry)).via, "demo@gmail.example");
	assert.equal(accountViewHref(entry), "/inbox?via=demo%40gmail.example");
});

test("only accounts that deliver into a mailbox in view are listed", () => {
	const entries = parseAccountViews({
		accounts: [account(), account({ id: "acc-2", mailboxId: "box-2", address: "b@gmail.example" })],
	});
	assert.deepEqual(
		accountViewsIn(entries, ["box-2"]).map((entry) => entry.id),
		["acc-2"],
	);
	assert.deepEqual(
		accountViewsIn(entries, ["box-1", "box-2"]).map((entry) => entry.id),
		["acc-1", "acc-2"],
	);
	assert.deepEqual(accountViewsIn(entries, []), []);
});

test("a view is open in the Inbox for exactly its account's address, in any letter case", () => {
	const entries = parseAccountViews({ accounts: [account()] });
	assert.equal(activeAccountView(entries, "demo@gmail.example", "/inbox")?.id, "acc-1");
	assert.equal(activeAccountView(entries, " Demo@Gmail.example ", "/inbox/message-1")?.id, "acc-1");
	assert.equal(activeAccountView(entries, "other@gmail.example", "/inbox"), null);
	assert.equal(activeAccountView(entries, null, "/inbox"), null);
	assert.equal(activeAccountView(entries, "", "/inbox"), null);
	assert.equal(activeAccountView(entries, "demo@gmail.example", "/sent"), null);
	assert.equal(activeAccountView(entries, "demo@gmail.example", "/inboxes"), null);
});

test("an open view is named by its account, or by the address it was opened with until the accounts load", () => {
	const entries = parseAccountViews({
		accounts: [account(), account({ id: "acc-2", label: "Work", address: "w@x.example" })],
	});
	assert.equal(openViewName(entries, "demo@gmail.example"), "Gmail");
	assert.equal(openViewName(entries, "W@X.example"), "Work");
	assert.equal(openViewName(entries, "gone@x.example"), "gone@x.example");
	assert.equal(openViewName(undefined, "demo@gmail.example"), "demo@gmail.example");
});

test("a view is left when the mailboxes in view no longer receive its account, never for an unknown address", () => {
	const accounts = parseAccountViews({
		accounts: [account(), account({ id: "acc-2", mailboxId: "box-2", address: "b@gmail.example" })],
	});
	const inBox1 = accountViewsIn(accounts, ["box-1"]);
	assert.equal(isAccountOutside(accounts, inBox1, "b@gmail.example"), true);
	assert.equal(isAccountOutside(accounts, inBox1, "B@Gmail.example"), true);
	assert.equal(isAccountOutside(accounts, inBox1, "demo@gmail.example"), false);
	assert.equal(isAccountOutside(accounts, accountViewsIn(accounts, ["box-1", "box-2"]), "b@gmail.example"), false);
	assert.equal(isAccountOutside(accounts, inBox1, "someone@else.example"), false);
});
