import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// The connect dialog's "New mailbox for this account": the suggested name, what is refused, who is offered it.

const { suggestMailboxLocalPart, mailboxLocalPartProblem, canOfferNewMailbox, submitLabel } = await bundleModules(
	"kite-new-mailbox-",
	[
		[
			"suggestMailboxLocalPart, mailboxLocalPartProblem, canOfferNewMailbox",
			"src/components/settings/connected-accounts/new-mailbox-utils.ts",
		],
		["submitLabel", "src/components/settings/connected-accounts/connected-accounts-utils.ts"],
	],
);

test("the suggested name is the part before the @ and the provider", () => {
	assert.equal(suggestMailboxLocalPart("mdgooijer@gmail.com"), "mdgooijer-gmail");
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
	const taken = new Set(["mdgooijer-gmail", "mdgooijer-gmail-2"]);
	assert.equal(suggestMailboxLocalPart("mdgooijer@gmail.com", taken), "mdgooijer-gmail-3");
	const long = suggestMailboxLocalPart(`${"a".repeat(80)}@gmail.com`);
	assert.ok(long.length <= 64);
	assert.equal(mailboxLocalPartProblem(long, new Set()), null);
});

test("a typed name is checked before anything is created", () => {
	const taken = new Set(["support"]);
	assert.equal(mailboxLocalPartProblem("mdgooijer-gmail", taken), null);
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
