import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	parseListLine,
	parseStatusLine,
	parseUidValidity,
	parseGmailLabels,
	decodeModifiedUtf7,
	planAccountFolders,
	gmailLabelDestination,
	flattenFolderName,
	parseAccountFolderRequest,
} = await bundleModules("kite-import-folder-mapping-", [
	[
		"parseListLine, parseStatusLine, parseUidValidity, parseGmailLabels, decodeModifiedUtf7",
		"src/lib/imap/protocol-utils.ts",
	],
	[
		"planAccountFolders, gmailLabelDestination, flattenFolderName, parseAccountFolderRequest",
		"src/lib/import/folder-mapping-utils.ts",
	],
]);

const mailbox = (name, attributes = [], delimiter = "/") => ({ name, delimiter, attributes });

test("LIST lines give the name, delimiter and attributes, quoted or not", () => {
	assert.deepEqual(parseListLine('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"'), {
		name: "Sent Items",
		delimiter: "/",
		attributes: ["\\HasNoChildren", "\\Sent"],
	});
	assert.deepEqual(parseListLine('* LIST () "." INBOX.Clients'), {
		name: "INBOX.Clients",
		delimiter: ".",
		attributes: [],
	});
	assert.deepEqual(parseListLine('* LIST (\\Noselect) NIL "a \\"b\\" \\\\c"'), {
		name: 'a "b" \\c',
		delimiter: null,
		attributes: ["\\Noselect"],
	});
	assert.equal(parseListLine('* LSUB () "/" INBOX'), null);
	assert.equal(parseListLine("A1 OK done"), null);
});

test("STATUS and UIDVALIDITY are read from their responses", () => {
	assert.deepEqual(parseStatusLine('* STATUS "Sent (old)" (MESSAGES 231 UIDNEXT 44292 UIDVALIDITY 7 SIZE 9000)'), {
		messages: 231,
		uidNext: 44292,
		uidValidity: 7,
		size: 9000,
	});
	assert.deepEqual(parseStatusLine("* STATUS INBOX (MESSAGES 3)"), {
		messages: 3,
		uidNext: null,
		uidValidity: null,
		size: null,
	});
	assert.equal(parseStatusLine("* 3 EXISTS"), null);
	assert.equal(parseUidValidity(["* 3 EXISTS", "* OK [UIDVALIDITY 3857529045] UIDs valid", "A1 OK"]), 3857529045);
	assert.equal(parseUidValidity(["A1 OK"]), null);
});

test("modified UTF-7 mailbox names are decoded", () => {
	assert.equal(decodeModifiedUtf7("Entw&APw-rfe"), "Entwürfe");
	assert.equal(decodeModifiedUtf7("&ZeVnLIqe-"), "日本語");
	assert.equal(decodeModifiedUtf7("Tom &- Jerry"), "Tom & Jerry");
	assert.equal(decodeModifiedUtf7("Plain"), "Plain");
	assert.equal(decodeModifiedUtf7("Broken &A-"), "Broken &A-");
});

test("Gmail labels are read with quoted names, system labels and UTF-7", () => {
	assert.deepEqual(
		parseGmailLabels('* 1 FETCH (UID 4 X-GM-LABELS (\\Inbox "Work/Clients" "\\\\Important" Entw&APw-rfe) BODY[] {5}'),
		["\\Inbox", "Work/Clients", "\\Important", "Entwürfe"],
	);
	assert.deepEqual(parseGmailLabels("* 1 FETCH (UID 4 X-GM-LABELS () BODY[] {5}"), []);
	assert.equal(parseGmailLabels("* 1 FETCH (UID 4 FLAGS () BODY[] {5}"), null);
});

test("folder names are flattened for Kite, without an INBOX prefix", () => {
	assert.equal(flattenFolderName(mailbox("Work/Clients/2026")), "Work / Clients / 2026");
	assert.equal(flattenFolderName(mailbox("INBOX.Clients", [], ".")), "Clients");
	assert.equal(flattenFolderName(mailbox("Proj&AOk-t", [], null)), "Projét");
	assert.equal(flattenFolderName(mailbox("x".repeat(100))).length, 80);
});

test("a special-use account maps onto Kite in the spec's order with spam and trash off", () => {
	const plan = planAccountFolders(
		[
			mailbox("Trash", ["\\Trash"]),
			mailbox("Zeta"),
			mailbox("INBOX"),
			mailbox("Junk", ["\\Junk"]),
			mailbox("Sent Items", ["\\Sent"]),
			mailbox("Work", ["\\Noselect", "\\HasChildren"]),
			mailbox("Work/Clients"),
			mailbox("Archive", ["\\Archive"]),
			mailbox("Drafts", ["\\Drafts"]),
			mailbox("All", ["\\All"]),
			mailbox("Flagged", ["\\Flagged"]),
			mailbox("alpha"),
			// The server announced a \Sent folder, so a folder merely named Sent is the user's own.
			mailbox("Sent"),
		],
		{ gmail: false },
	);
	assert.deepEqual(
		plan.map(({ sourceName, role, include, destination }) => [sourceName, role, include, destination]),
		[
			["INBOX", "inbox", true, "system:inbox"],
			["Sent Items", "sent", true, "system:sent"],
			["Archive", "archive", true, "system:archived"],
			["alpha", "user", true, "new:alpha"],
			["Sent", "user", true, "new:Sent"],
			["Work/Clients", "user", true, "new:Work / Clients"],
			["Zeta", "user", true, "new:Zeta"],
			["Junk", "junk", false, "system:spam"],
			["Trash", "trash", false, "system:trash"],
		],
	);
});

test("without special-use attributes, standard names find their role", () => {
	const plan = planAccountFolders(
		[
			mailbox("INBOX", [], "."),
			mailbox("INBOX.Sent Messages", [], "."),
			mailbox("INBOX.Deleted Items", [], "."),
			mailbox("INBOX.Spam", [], "."),
			mailbox("INBOX.Drafts", [], "."),
			mailbox("INBOX.Clients.Archive", [], "."),
		],
		{ gmail: false },
	);
	assert.deepEqual(
		plan.map(({ displayName, role }) => [displayName, role]),
		[
			["INBOX", "inbox"],
			["Sent Messages", "sent"],
			["Clients / Archive", "user"],
			["Spam", "junk"],
			["Deleted Items", "trash"],
		],
	);
});

test("Gmail copies All Mail once by label, and offers Spam and Trash switched off", () => {
	const plan = planAccountFolders(
		[
			mailbox("INBOX"),
			mailbox("[Gmail]", ["\\Noselect"]),
			mailbox("[Gmail]/All Mail", ["\\All"]),
			mailbox("[Gmail]/Sent Mail", ["\\Sent"]),
			mailbox("[Gmail]/Spam", ["\\Junk"]),
			mailbox("[Gmail]/Bin", ["\\Trash"]),
			mailbox("[Gmail]/Drafts", ["\\Drafts"]),
			mailbox("[Gmail]/Important", ["\\Important"]),
			mailbox("Work"),
		],
		{ gmail: true },
	);
	assert.deepEqual(
		plan.map(({ sourceName, role, include, destination }) => [sourceName, role, include, destination]),
		[
			["[Gmail]/All Mail", "all", true, "gmail:labels"],
			["[Gmail]/Spam", "junk", false, "system:spam"],
			["[Gmail]/Bin", "trash", false, "system:trash"],
		],
	);
});

test("a Gmail message goes by Inbox, then Sent, then its first user label, else Archive; drafts are skipped", () => {
	assert.deepEqual(gmailLabelDestination(["\\Inbox", "Work"]), { destination: "system:inbox", userLabels: 1 });
	assert.deepEqual(gmailLabelDestination(["\\Sent", "\\Important"]), { destination: "system:sent", userLabels: 0 });
	assert.deepEqual(gmailLabelDestination(["Work/Clients", "alpha"]), { destination: "new:alpha", userLabels: 2 });
	assert.deepEqual(gmailLabelDestination(["Work/Clients"]), { destination: "new:Work / Clients", userLabels: 1 });
	assert.deepEqual(gmailLabelDestination(["\\Starred"]), { destination: "system:archived", userLabels: 0 });
	assert.deepEqual(gmailLabelDestination([]), { destination: "system:archived", userLabels: 0 });
	assert.deepEqual(gmailLabelDestination(["\\Draft", "\\Inbox"]), { destination: null, userLabels: 0 });
});

test("account job requests keep the included folders and refuse anything else", () => {
	const folders = parseAccountFolderRequest([
		{ sourceName: "INBOX", role: "inbox", destination: "system:inbox", include: true, bytes: 1200 },
		{ sourceName: "Junk", role: "junk", destination: "system:spam", include: false },
		{ sourceName: "Work", role: "user", destination: "new:Work", bytes: "x" },
		{ sourceName: "Clients", role: "user", destination: "folder:fld_abc-1" },
		{ sourceName: "[Gmail]/All Mail", role: "all", destination: "gmail:labels" },
	]);
	assert.deepEqual(
		folders.map(({ sourceName, destination, bytes }) => [sourceName, destination, bytes]),
		[
			["INBOX", "system:inbox", 1200],
			["Work", "new:Work", null],
			["Clients", "folder:fld_abc-1", null],
			["[Gmail]/All Mail", "gmail:labels", null],
		],
	);
	for (const [entry, message] of [
		[{ sourceName: "", role: "user", destination: "new:x" }, /invalid/],
		[{ sourceName: "a\r\nb", role: "user", destination: "new:x" }, /invalid/],
		[{ sourceName: "A", role: "drafts", destination: "system:inbox" }, /role/],
		[{ sourceName: "A", role: "user", destination: "system:drafts" }, /Choose where/],
		[{ sourceName: "A", role: "user", destination: "gmail:labels" }, /Choose where/],
		[{ sourceName: "A", role: "user", destination: "new:" }, /Choose where/],
	])
		assert.throws(() => parseAccountFolderRequest([entry]), message);
	assert.throws(() => parseAccountFolderRequest("INBOX"), /Choose the folders/);
	assert.throws(
		() => parseAccountFolderRequest([{ sourceName: "A", role: "user", destination: "new:A", include: false }]),
		/at least one/,
	);
	assert.throws(() => parseAccountFolderRequest(Array.from({ length: 501 }, () => ({}))), /at most 500/);
});
