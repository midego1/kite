import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// The connect dialog's "New mailbox for this account": the suggested name, what is refused, who is offered it.

const {
	suggestMailboxLocalPart,
	mailboxLocalPartProblem,
	canOfferNewMailbox,
	chosenMailboxId,
	unusedMailboxAddress,
	firstId,
	errorText,
	NEW_MAILBOX_VALUE,
	submitLabel,
} = await bundleModules("kite-new-mailbox-", [
	[
		"suggestMailboxLocalPart, mailboxLocalPartProblem, canOfferNewMailbox, chosenMailboxId, unusedMailboxAddress, firstId, errorText, NEW_MAILBOX_VALUE",
		"src/components/settings/connected-accounts/new-mailbox-utils.ts",
	],
	["submitLabel", "src/components/settings/connected-accounts/connected-accounts-utils.ts"],
]);

test("the suggested name is the part before the @ and the provider", () => {
	assert.equal(suggestMailboxLocalPart("jane@example.com"), "jane-example");
	assert.equal(suggestMailboxLocalPart("  Jane.Doe@Outlook.com "), "jane.doe-outlook");
	assert.equal(suggestMailboxLocalPart("first+tag@fastmail.com"), "first-tag-fastmail");
	assert.equal(suggestMailboxLocalPart("émile@icloud.com"), "emile-icloud");
	assert.equal(suggestMailboxLocalPart("--@gmail.com"), "gmail");
	// Nothing to suggest before an address is typed.
	assert.equal(suggestMailboxLocalPart(""), "");
	assert.equal(suggestMailboxLocalPart("not-an-address"), "not-an-address");
	assert.equal(suggestMailboxLocalPart("@"), "");
});

test("a taken suggestion gets a number, and a long one is shortened to a valid name", () => {
	const taken = new Set(["jane-example", "jane-example-2"]);
	assert.equal(suggestMailboxLocalPart("jane@example.com", taken), "jane-example-3");
	const long = suggestMailboxLocalPart(`${"a".repeat(80)}@gmail.com`);
	assert.ok(long.length <= 64);
	assert.equal(mailboxLocalPartProblem(long, new Set()), null);
});

test("a typed name is checked before anything is created", () => {
	const taken = new Set(["support"]);
	assert.equal(mailboxLocalPartProblem("jane-example", taken), null);
	assert.equal(mailboxLocalPartProblem("  Mixed.Case_ok  ", taken), null);
	assert.match(mailboxLocalPartProblem("", taken), /Enter a name/);
	assert.match(mailboxLocalPartProblem("support", taken), /already a mailbox/);
	assert.match(mailboxLocalPartProblem("Support", taken), /already a mailbox/);
	for (const bad of ["-start", "end-", "has space", "a@b", "ünï", "x".repeat(65)])
		assert.match(mailboxLocalPartProblem(bad, taken), /letters, digits/, bad);
});

test("only people who may create mailboxes, on a domain they may use, are offered one", () => {
	const domain = { id: "d1", hostname: "example.com" };
	assert.equal(canOfferNewMailbox({ role: "admin", canManageMailboxes: false }, [domain]), true);
	assert.equal(canOfferNewMailbox({ role: "user", canManageMailboxes: true }, [domain]), true);
	assert.equal(canOfferNewMailbox({ role: "user", canManageMailboxes: false }, [domain]), false);
	assert.equal(canOfferNewMailbox({ role: "admin", canManageMailboxes: true }, []), false);
	assert.equal(canOfferNewMailbox(null, [domain]), false);
	assert.equal(canOfferNewMailbox(undefined, [domain]), false);
});

test("the submit button says what it is doing", () => {
	assert.equal(submitLabel("mailbox", false), "Creating the mailbox…");
	assert.equal(submitLabel("account", false), "Testing the connection…");
	assert.equal(submitLabel(null, false), "Connect");
	assert.equal(submitLabel(null, true), "Save");
	assert.equal(submitLabel("delete", false), "Connect");
});

test("with no mailbox to choose from the new mailbox is the choice, never a dead end", () => {
	const choose = (input) =>
		chosenMailboxId({ chosen: "", firstManaged: undefined, offered: true, loading: false, ...input });
	assert.equal(choose({}), NEW_MAILBOX_VALUE);
	assert.equal(choose({ firstManaged: "mbx_1" }), "mbx_1");
	assert.equal(choose({ chosen: "mbx_2", firstManaged: "mbx_1" }), "mbx_2");
	// Not offered (no permission), or the list has not loaded yet: nothing is chosen for the person.
	assert.equal(choose({ offered: false }), "");
	assert.equal(choose({ loading: true }), "");
});

test("a mailbox the dialog made is reported as unused only when the account went elsewhere", () => {
	const created = { id: "mbx_new", address: "jane-example@example.com" };
	assert.equal(unusedMailboxAddress(created, "mbx_other"), "jane-example@example.com");
	assert.equal(unusedMailboxAddress(created, "mbx_new"), undefined);
	assert.equal(unusedMailboxAddress(null, "mbx_other"), undefined);
});

test("small helpers of the dialog", () => {
	assert.equal(firstId(undefined, "", "a", "b"), "a");
	assert.equal(firstId(), "");
	assert.equal(errorText(new Error("no"), "fallback"), "no");
	assert.equal(errorText("x", "fallback"), "fallback");
});
