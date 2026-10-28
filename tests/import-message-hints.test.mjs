import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { applyImportHints, getImportMessageHints, parseGmailLabelHeader } = await bundleModules("kite-import-hints-", [
	["applyImportHints, getImportMessageHints, parseGmailLabelHeader", "src/lib/import/message-hints-utils.ts"],
]);

const raw = (headers, body = "body") => new TextEncoder().encode(`${headers}\n\n${body}`).buffer;
const hints = (headers) => getImportMessageHints(raw(headers));

test("mbox Status and X-Status set the read state", () => {
	assert.equal(hints("Status: RO\nSubject: a").read, true);
	assert.equal(hints("Status: R\nSubject: a").read, true);
	assert.equal(hints("Status: O\nSubject: a").read, false);
	assert.equal(hints("status: RO").read, true);
	assert.equal(hints("X-Status: AR").read, true);
	assert.equal(hints("Status: O\nX-Status: A").read, false);
	assert.equal(hints("Subject: a").read, undefined);
});

test("X-Status F stars the message", () => {
	assert.equal(hints("X-Status: AF").starred, true);
	assert.equal(hints("X-Status: A").starred, undefined);
});

test("a Status that is not a status is ignored", () => {
	assert.equal(hints("Status: read it please\nSubject: a").read, undefined);
	assert.equal(hints("Status:\nSubject: a").read, undefined);
	// Words are not flag letters: only R, O, A, D, F and T count, in capitals.
	assert.equal(hints("Status: Approved").read, undefined);
	assert.equal(hints("Status: Read").read, undefined);
	assert.equal(hints("Status: ro").read, undefined);
	assert.equal(hints("X-Status: Flagged").starred, undefined);
	assert.equal(hints("Status: " + "R".repeat(5000)).read, undefined);
});

test("Gmail Takeout labels give the read state, star and spam or trash", () => {
	assert.equal(hints("X-Gmail-Labels: Inbox,Unread").read, false);
	assert.equal(hints("X-Gmail-Labels: Inbox,Important").read, true);
	assert.equal(hints("X-Gmail-Labels: Inbox, UNREAD").read, false);
	assert.equal(hints("X-Gmail-Labels: Starred,Inbox").starred, true);
	assert.equal(hints("X-Gmail-Labels: Inbox").starred, undefined);
	assert.equal(hints("X-Gmail-Labels: Spam,Unread").section, "spam");
	assert.equal(hints("X-Gmail-Labels: Spam,Unread").read, false);
	assert.equal(hints("X-Gmail-Labels: Trash").section, "trash");
	assert.equal(hints("X-Gmail-Labels: Spam,Trash").section, "trash");
	assert.equal(hints("X-Gmail-Labels: Inbox").section, undefined);
	// Labels win over Status where they speak.
	assert.equal(hints("Status: O\nX-Gmail-Labels: Inbox").read, true);
});

test("a user label that contains a system label's name does not count", () => {
	assert.equal(hints('X-Gmail-Labels: Inbox,"Spam, ham",Work').section, undefined);
	assert.equal(hints("X-Gmail-Labels: Inbox,Spammy,Trash can").section, undefined);
	assert.deepEqual(parseGmailLabelHeader('Inbox, "Spam, ham" ,,Work'), {
		labels: ["inbox", "spam, ham", "work"],
		complete: true,
	});
});

test("X-Spam-Flag does not override Gmail's verdict", () => {
	assert.equal(hints("X-Gmail-Labels: Inbox,Important\nX-Spam-Flag: YES").section, undefined);
	assert.equal(hints("X-Spam-Flag: YES\nX-Gmail-Labels: Inbox").section, undefined);
	assert.equal(hints("X-Gmail-Labels: Inbox,Spam\nX-Spam-Flag: NO").section, "spam");
});

test("only the first X-Gmail-Labels header is read", () => {
	const first = hints("X-Gmail-Labels: Inbox,Important\nX-Gmail-Labels: Spam,Trash,Starred,Unread");
	assert.deepEqual(first, { read: true });
	assert.deepEqual(hints("X-Gmail-Labels: Inbox,Unread\nX-Gmail-Labels: Opened"), { read: false });
});

test("read comes only from a positive sign, never from a missing Unread", () => {
	assert.equal(hints("X-Gmail-Labels: Opened").read, true);
	assert.equal(hints("X-Gmail-Labels: Inbox,Category Updates").read, true);
	assert.equal(hints("X-Gmail-Labels: Sent").read, true);
	assert.equal(hints("X-Gmail-Labels: Unread,Opened").read, false);
	// A localized or custom list names no Gmail label, so it says nothing.
	assert.equal(hints("X-Gmail-Labels: Posteingang,Ungelesen").read, undefined);
	assert.equal(hints("X-Gmail-Labels: Work,Family").read, undefined);
	assert.equal(hints("X-Gmail-Labels: ").read, undefined);
	// Status still speaks when the labels do not.
	assert.equal(hints("Status: RO\nX-Gmail-Labels: Work").read, true);
});

test("a truncated or unbalanced label list is not trusted about Unread", () => {
	const filler = Array.from({ length: 120 }, (_, index) => `L${index}`).join(",");
	// More labels than are kept: Unread may have been cut off.
	assert.equal(hints(`X-Gmail-Labels: Inbox,${filler},Unread`).read, undefined);
	assert.equal(parseGmailLabelHeader(`Inbox,${filler}`).complete, false);
	// The value hits the length cap.
	const long = `Inbox,${"x".repeat(5000)},Unread`;
	assert.equal(hints(`X-Gmail-Labels: ${long}`).read, undefined);
	// An open quote swallows the rest of the list.
	assert.equal(hints('X-Gmail-Labels: Inbox,"Work,Unread').read, undefined);
	assert.equal(parseGmailLabelHeader('Inbox,"Work,Unread').complete, false);
	// What survived still counts when it is a positive sign of unread or of a verdict.
	assert.equal(hints(`X-Gmail-Labels: Unread,${filler}`).read, false);
	assert.equal(hints(`X-Gmail-Labels: Spam,${filler}`).section, "spam");
});

test("a header block cut by the 64 KiB cap loses its partial last line", () => {
	const cap = 64 * 1024;
	const label = "X-Gmail-Labels: Inbox,Unread";
	// Pad so the cap falls inside the label list, after "Inbox,Unre".
	const padLine = (size) => `X-Pad: ${"x".repeat(size - 8)}\n`;
	const head = `Subject: a\n${padLine(cap - 11 - 1 - (label.length - 2))}`;
	const message = new TextEncoder().encode(`${head}${label}\n\nbody ${"z".repeat(100)}`).buffer;
	assert.equal(head.length + label.length - 2, cap - 1);
	assert.deepEqual(getImportMessageHints(message), {});
});

test("X-Spam-Flag YES means spam", () => {
	assert.equal(hints("X-Spam-Flag: YES").section, "spam");
	assert.equal(hints("x-spam-flag: yes").section, "spam");
	assert.equal(hints("X-Spam-Flag: NO").section, undefined);
	assert.equal(hints("X-Spam-Flag: yesterday").section, undefined);
	// A message in Gmail's Trash stays in the trash.
	assert.equal(hints("X-Spam-Flag: YES\nX-Gmail-Labels: Trash").section, "trash");
});

test("folded headers are joined and CRLF is understood", () => {
	assert.equal(hints("X-Gmail-Labels: Inbox,\n Spam").section, "spam");
	const crlf = new TextEncoder().encode("Subject: a\r\nStatus: RO\r\n\r\nStatus: O").buffer;
	assert.equal(getImportMessageHints(crlf).read, true);
});

test("only the headers are read, never the body", () => {
	const message = raw("Subject: a", "Status: RO\nX-Spam-Flag: YES\nX-Gmail-Labels: Spam");
	assert.deepEqual(getImportMessageHints(message), {});
});

test("headers beyond the first 64 KiB are not read, and garbage does not throw", () => {
	const long = `Subject: a\n${"X-Pad: x\n".repeat(9000)}X-Spam-Flag: YES`;
	assert.deepEqual(hints(long), {});
	assert.deepEqual(getImportMessageHints(new Uint8Array([0xff, 0xfe, 0, 58, 10]).buffer), {});
	assert.deepEqual(getImportMessageHints(new ArrayBuffer(0)), {});
});

test("hints only refine the Inbox destination", () => {
	const spam = { section: "spam" };
	assert.deepEqual(applyImportHints({ type: "system", section: "inbox" }, spam), { type: "system", section: "spam" });
	assert.deepEqual(applyImportHints({ type: "system", section: "inbox" }, { section: "trash" }), {
		type: "system",
		section: "trash",
	});
	assert.deepEqual(applyImportHints({ type: "system", section: "inbox" }, { read: true }), {
		type: "system",
		section: "inbox",
	});
	for (const section of ["sent", "drafts", "archived", "trash"]) {
		assert.deepEqual(applyImportHints({ type: "system", section }, spam), { type: "system", section });
	}
	assert.deepEqual(applyImportHints({ type: "folder", folderId: "f" }, spam), { type: "folder", folderId: "f" });
});
