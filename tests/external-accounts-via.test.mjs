import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { bundleModules } from "./support/modules-bundle.mjs";

// Connected accounts, PR 8 (docs/specs/external-accounts.md §6.1, §6.3, §18 decision 1): the "via" chip's text and
// search, the `via:` operator and what it matches, the Spam folder's raw keys and how a run finds the folder, and the
// forwarding guide's data.

const {
	viaChipText,
	viaChipTitle,
	viaSearchQuery,
	viaSearchFilter,
	parseSearchQuery,
	buildSearchConditions,
	messages,
	externalRawKey,
	parseExternalRawKey,
	findJunkFolder,
	FORWARDING_PROVIDERS,
	FORWARDING_CHECKS,
	forwardingProviderFor,
	forwardingStepParts,
	EXTERNAL_ACCOUNT_PRESETS,
} = await bundleModules("kite-external-accounts-via-", [
	["viaChipText, viaChipTitle, viaSearchQuery, viaSearchFilter", "src/lib/external-accounts/via-utils.ts"],
	["parseSearchQuery", "src/lib/search/query-utils.ts"],
	["buildSearchConditions", "src/lib/search/conditions.ts"],
	["messages", "src/db/schema/index.ts"],
	["externalRawKey, parseExternalRawKey, findJunkFolder", "src/lib/external-accounts/sync-utils.ts"],
	[
		"FORWARDING_PROVIDERS, FORWARDING_CHECKS, forwardingProviderFor, forwardingStepParts",
		"src/components/settings/connected-accounts/forwarding-guide-utils.ts",
	],
	["EXTERNAL_ACCOUNT_PRESETS", "src/lib/external-accounts/presets-utils.ts"],
]);

const gmail = { accountId: "xacct_1", label: "me@gmail.com", address: "me@gmail.com", preset: "gmail" };

test("the chip names the provider until the account gets a label of its own", () => {
	assert.equal(viaChipText(gmail), "Gmail");
	assert.equal(viaChipText({ ...gmail, label: "ME@Gmail.com " }), "Gmail", "the address in another case is no label");
	assert.equal(viaChipText({ ...gmail, label: "Work" }), "Work");
	assert.equal(viaChipText({ ...gmail, preset: "icloud" }), "iCloud Mail");
	// An "Other" account has no provider name: its domain stands in.
	assert.equal(
		viaChipText({ label: "a@mail.example.org", address: "a@mail.example.org", preset: "other" }),
		"mail.example.org",
	);
	assert.equal(viaChipTitle(gmail, "inbound"), "Arrived through me@gmail.com");
	assert.equal(viaChipTitle(gmail, "outbound"), "Sent through me@gmail.com");
	assert.equal(viaSearchQuery(gmail), "via:me@gmail.com");
});

test("via: is an operator like the others, quoted or not, and leaves the free text alone", () => {
	assert.equal(parseSearchQuery("via:gmail invoice").via, "gmail");
	assert.equal(parseSearchQuery("invoice").via, undefined);
	assert.equal(parseSearchQuery('via:"Work Gmail" is:unread').via, "Work Gmail");
	assert.equal(parseSearchQuery('via:"Work Gmail" is:unread').read, "unread");
	assert.equal(parseSearchQuery("via:gmail invoice").text, "invoice");
	assert.equal(parseSearchQuery("via:gmail").needsFullText, false, "no full-text index needed for via: alone");
	assert.equal(parseSearchQuery('via:""').via, undefined);
});

test("a via: value names a provider (with everyday aliases), an address, a label or a domain", () => {
	assert.deepEqual(viaSearchFilter("Gmail").presets, ["gmail"]);
	assert.deepEqual(viaSearchFilter("google").presets.sort(), ["gmail", "google_workspace"]);
	assert.deepEqual(viaSearchFilter("outlook").presets, ["microsoft"]);
	assert.deepEqual(viaSearchFilter("icloud").presets, ["icloud"]);
	assert.deepEqual(viaSearchFilter("iCloud Mail").presets, ["icloud"]);
	assert.deepEqual(viaSearchFilter("google-workspace").presets, ["google_workspace"]);
	assert.deepEqual(viaSearchFilter("Work").presets, []);
	assert.equal(viaSearchFilter("Me@Gmail.com").value, "me@gmail.com");
	assert.equal(viaSearchFilter("Me@Gmail.com").domain, null);
	assert.equal(viaSearchFilter("example.org").domain, "example.org");
	// Every preset can be found by its own id.
	for (const preset of EXTERNAL_ACCOUNT_PRESETS) assert.ok(viaSearchFilter(preset.id).presets.includes(preset.id));
});

test("the via: condition matches messages by their account, and before migration 0079 matches nothing", () => {
	const sqlite = new Database(":memory:");
	sqlite.exec(`
		CREATE TABLE messages (id TEXT PRIMARY KEY, external_account_id TEXT);
		CREATE TABLE external_accounts (id TEXT PRIMARY KEY, address TEXT, label TEXT, preset TEXT);
		INSERT INTO external_accounts VALUES ('a1', 'me@gmail.com', 'me@gmail.com', 'gmail');
		INSERT INTO external_accounts VALUES ('a2', 'work@corp.example', 'Work Mail', 'google_workspace');
		INSERT INTO external_accounts VALUES ('a3', 'x_y@odd_host.test', 'Odd', 'other');
		INSERT INTO external_accounts VALUES ('a4', 'xzy@oddxhost.test', 'Look-alike', 'other');
		INSERT INTO messages VALUES ('m1', 'a1'), ('m2', 'a2'), ('m3', 'a3'), ('m4', 'a4'), ('m5', NULL);
	`);
	const db = drizzle(sqlite);
	const find = (query, options = { connectedAccounts: true }) =>
		db
			.select({ id: messages.id })
			.from(messages)
			.where(and(...buildSearchConditions(query, "UTC", options)))
			.orderBy(messages.id)
			.all()
			.map((row) => row.id);
	assert.deepEqual(find("via:gmail"), ["m1"]);
	assert.deepEqual(find("via:google"), ["m1", "m2"]);
	assert.deepEqual(find("via:ME@gmail.com"), ["m1"]);
	assert.deepEqual(find('via:"work mail"'), ["m2"]);
	assert.deepEqual(find("via:corp.example"), ["m2"]);
	// `_` in a domain is literal, not a wildcard.
	assert.deepEqual(find("via:odd_host.test"), ["m3"]);
	assert.deepEqual(find("via:nobody"), []);
	assert.deepEqual(find("via:gmail", { connectedAccounts: false }), []);
});

test("the Spam folder's messages have keys of their own, and INBOX keeps the key it always had", () => {
	assert.equal(externalRawKey("xacct_1", 7, 42), "external/xacct_1/7/42.eml");
	assert.equal(externalRawKey("xacct_1", 7, 42, "junk"), "external/xacct_1/junk/7/42.eml");
	assert.deepEqual(parseExternalRawKey("external/xacct_1/7/42.eml"), { role: "inbox", uidValidity: 7, uid: 42 });
	assert.deepEqual(parseExternalRawKey("external/xacct_1/junk/7/42.eml"), { role: "junk", uidValidity: 7, uid: 42 });
	assert.equal(parseExternalRawKey("imports/xacct_1/7/42.eml"), null);
	assert.equal(parseExternalRawKey("external/xacct_1/sent/7/42.eml"), null);
});

test("a run finds the Spam folder by its \\Junk attribute first, then by a top-level or INBOX.<name> name, never INBOX", () => {
	const entry = (name, attributes = [], delimiter = "/") => ({ name, delimiter, attributes });
	assert.equal(
		findJunkFolder([entry("INBOX"), entry("[Gmail]/Spam", ["\\HasNoChildren", "\\Junk"]), entry("Spam")]),
		"[Gmail]/Spam",
	);
	assert.equal(findJunkFolder([entry("INBOX"), entry("Bulk Mail")]), "Bulk Mail");
	assert.equal(findJunkFolder([entry("INBOX"), entry("INBOX.Junk", [], "."), entry("Junk", [], ".")]), "Junk");
	assert.equal(findJunkFolder([entry("Junk E-mail")]), "Junk E-mail");
	assert.equal(findJunkFolder([entry("[Gmail]", ["\\Noselect", "\\Junk"]), entry("Archive")]), null);
	assert.equal(findJunkFolder([entry("INBOX", ["\\Junk"]), entry("Projects/Spam filters")]), null);
	assert.equal(findJunkFolder([]), null);
	// By name only at the top level or directly under INBOX; a user's own folder deeper down never counts.
	assert.equal(findJunkFolder([entry("INBOX"), entry("INBOX.Junk", [], ".")]), "INBOX.Junk");
	assert.equal(findJunkFolder([entry("inbox/Spam")]), "inbox/Spam");
	assert.equal(findJunkFolder([entry("Projects/Spam"), entry("Clients/Acme/Junk")]), null);
	assert.equal(findJunkFolder([entry("INBOX/Old/Spam")]), null);
	assert.equal(findJunkFolder([entry("Bulk"), entry("bulk")]), null, "bare Bulk is too common a folder name");
});

test("the forwarding guide covers each provider with real https settings pages and fills in the Kite address", () => {
	const ids = FORWARDING_PROVIDERS.map((provider) => provider.id);
	assert.deepEqual(ids, ["gmail", "microsoft", "icloud", "yahoo", "fastmail", "other"]);
	for (const provider of FORWARDING_PROVIDERS) {
		assert.ok(
			provider.steps.some((step) => step.includes("{address}")),
			`${provider.id} names the address`,
		);
		for (const link of [...provider.settings.map((entry) => entry.url), provider.help].filter(Boolean))
			assert.match(link, /^https:\/\/[a-z0-9.-]+\.(com|help)\//, link);
	}
	assert.ok(
		FORWARDING_PROVIDERS.find((provider) => provider.id === "microsoft").notes.some((note) =>
			/cannot connect/.test(note),
		),
	);
	assert.ok(FORWARDING_CHECKS.some((check) => /arrive twice/.test(check)));
	// Every connect-dialog provider opens a tab of the guide.
	for (const preset of EXTERNAL_ACCOUNT_PRESETS) assert.ok(ids.includes(forwardingProviderFor(preset.id)), preset.id);
	assert.equal(forwardingProviderFor("google_workspace"), "gmail");
	assert.deepEqual(forwardingStepParts("Enter {address} and choose Save.", "me@kite.test"), [
		{ text: "Enter ", address: false },
		{ text: "me@kite.test", address: true },
		{ text: " and choose Save.", address: false },
	]);
	assert.deepEqual(forwardingStepParts("{address}", "me@kite.test"), [{ text: "me@kite.test", address: true }]);
});
