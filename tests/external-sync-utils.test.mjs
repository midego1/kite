import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Sync bookkeeping of connected accounts (spec §6.3, §6.5, §6.6, §14.1; PR 7): the plan per INBOX check, the `n:*`
// quirk and the run cap, the UIDVALIDITY reset, backoff with jitter bounds, `classifySyncError`, the trusted
// Authentication-Results rule per preset, the restore of messages whose account is gone, and the sidebar notice text.

const {
	planInboxSync,
	baselineLastUid,
	resetLastUid,
	selectNewMessages,
	externalRawKey,
	sourceFlags,
	classifySyncError,
	failureDelayMs,
	syncFailureUpdate,
	isSyncStateChange,
	nextRegularSync,
	parseSyncInterval,
	isExternalSyncMessage,
	externalSyncMessage,
	MAX_SYNC_BACKOFF_MS,
	parseFetchSummaries,
	imapSearchDate,
	externalAuthenticationResults,
	detachMissingExternalAccounts,
	parseAttentionAccounts,
	connectedAccountsBannerContent,
	syncStatusText,
	canCheckNow,
	relativeTime,
	describeQueueMessage,
	shortServerText,
	MailServerRefusedError,
} = await bundleModules("kite-external-sync-utils-", [
	[
		"planInboxSync, baselineLastUid, resetLastUid, selectNewMessages, externalRawKey, sourceFlags, classifySyncError, failureDelayMs, syncFailureUpdate, isSyncStateChange, nextRegularSync, parseSyncInterval, isExternalSyncMessage, externalSyncMessage, MAX_SYNC_BACKOFF_MS",
		"src/lib/external-accounts/sync-utils.ts",
	],
	["parseFetchSummaries, imapSearchDate", "src/lib/imap/protocol-utils.ts"],
	["externalAuthenticationResults", "src/lib/spam/authentication-results-utils.ts"],
	["detachMissingExternalAccounts", "src/lib/backups/external-accounts-utils.ts"],
	["parseAttentionAccounts, connectedAccountsBannerContent", "src/components/connected-accounts-banner-utils.ts"],
	["syncStatusText, canCheckNow, relativeTime", "src/components/settings/connected-accounts/connected-accounts-utils.ts"],
	["describeQueueMessage", "worker-utils.ts"],
	["shortServerText", "src/lib/external-accounts/connection-utils.ts"],
	["MailServerRefusedError", "src/lib/net/errors.ts"],
]);

test("an INBOX check is one EXAMINE when nothing arrived, and fetches from the cursor otherwise", () => {
	assert.deepEqual(planInboxSync(null, { uidValidity: 7, uidNext: 10 }), { kind: "baseline" });
	assert.deepEqual(planInboxSync({ uidValidity: 7, lastUid: null }, { uidValidity: 7, uidNext: 10 }), {
		kind: "baseline",
	});
	assert.deepEqual(planInboxSync({ uidValidity: 7, lastUid: 9 }, { uidValidity: 7, uidNext: 10 }), {
		kind: "unchanged",
	});
	assert.deepEqual(planInboxSync({ uidValidity: 7, lastUid: 9 }, { uidValidity: 7, uidNext: 12 }), {
		kind: "fetch",
		fromUid: 10,
	});
	// Without UIDNEXT nothing can be ruled out, so the run asks the server.
	assert.deepEqual(planInboxSync({ uidValidity: 7, lastUid: 9 }, { uidValidity: 7, uidNext: null }), {
		kind: "fetch",
		fromUid: 10,
	});
	assert.deepEqual(planInboxSync({ uidValidity: 7, lastUid: 9 }, { uidValidity: 8, uidNext: 3 }), { kind: "reset" });
	// A server that names no UIDVALIDITY never looks reset.
	assert.deepEqual(planInboxSync({ uidValidity: null, lastUid: 9 }, { uidValidity: 8, uidNext: 10 }), {
		kind: "unchanged",
	});

	assert.equal(baselineLastUid(10), 9);
	assert.equal(baselineLastUid(1), 0);
	assert.equal(baselineLastUid(null, [4, 12, 7]), 12);
	assert.equal(baselineLastUid(null), 0);
	assert.equal(resetLastUid([40, 38, 41], 50), 37);
	assert.equal(resetLastUid([], 50), 49);
	assert.equal(resetLastUid([1], null), 0);
});

test("a run takes only UIDs above the cursor, oldest first, at most the cap", () => {
	// `n:*` with nothing new answers the highest UID, which is below n.
	assert.deepEqual(selectNewMessages([{ uid: 9 }], 9), { take: [], more: false });
	const summaries = [{ uid: 14 }, { uid: 11 }, { uid: 12 }, { uid: 9 }, { uid: 12 }, { uid: 13 }];
	assert.deepEqual(selectNewMessages(summaries, 10), {
		take: [{ uid: 11 }, { uid: 12 }, { uid: 13 }, { uid: 14 }],
		more: false,
	});
	assert.deepEqual(selectNewMessages(summaries, 10, 2), { take: [{ uid: 11 }, { uid: 12 }], more: true });
	assert.equal(selectNewMessages(Array.from({ length: 250 }, (_, i) => ({ uid: i + 1 })), 0).take.length, 200);
});

test("synced objects have deterministic keys and the source flags become read and starred", () => {
	assert.equal(externalRawKey("xacct_1", 7, 42), "external/xacct_1/7/42.eml");
	assert.equal(externalRawKey("xacct_1", null, 42), "external/xacct_1/0/42.eml");
	assert.deepEqual(sourceFlags(["\\Seen", "$Forwarded"]), { read: true, starred: false });
	assert.deepEqual(sourceFlags(["\\flagged"]), { read: false, starred: true });
	assert.deepEqual(sourceFlags([]), { read: false, starred: false });
	assert.equal(parseSyncInterval("15"), 15);
	assert.equal(parseSyncInterval(60), 60);
	assert.equal(parseSyncInterval(1), null);
	assert.equal(parseSyncInterval("x"), null);
	assert.ok(isExternalSyncMessage(externalSyncMessage("xacct_1")));
	assert.equal(isExternalSyncMessage({ kind: "accounts.sync" }), false);
	assert.equal(isExternalSyncMessage(null), false);
	assert.equal(isExternalSyncMessage({ kind: "import.imap", accountId: "x" }), false);
	// Failure logs name the synced object's key (account id, UIDVALIDITY, UID: no address) and the kind.
	assert.deepEqual(
		describeQueueMessage({ from: "a@b.test", to: "c@d.test", rawR2Key: "external/xacct_1/7/42.eml" }),
		{ kind: "inbound", rawR2Key: "external/xacct_1/7/42.eml" },
	);
	assert.deepEqual(describeQueueMessage(externalSyncMessage("xacct_1")), { kind: "external_sync" });
});

test("attribute-only FETCH answers and SEARCH dates parse", () => {
	const summaries = parseFetchSummaries([
		'* 3 FETCH (UID 12 FLAGS (\\Seen \\Flagged) INTERNALDATE "27-Oct-2026 10:00:00 +0000" RFC822.SIZE 2048)',
		"* 4 FETCH (FLAGS (\\Seen))",
		"* OK still here",
		'* 5 FETCH (UID 13 FLAGS () RFC822.SIZE 10 INTERNALDATE "nonsense")',
		"A0003 OK done",
	]);
	assert.deepEqual(summaries, [
		{ uid: 12, flags: ["\\Seen", "\\Flagged"], internalDate: new Date("2026-10-27T10:00:00Z"), size: 2048 },
		{ uid: 13, flags: [], internalDate: null, size: 10 },
	]);
	assert.equal(imapSearchDate(new Date("2026-10-07T23:59:00Z")), "7-Oct-2026");
	assert.equal(imapSearchDate(new Date("2027-01-31T00:00:00Z")), "31-Jan-2027");
});

test("sync errors are sorted into classes without the password, and cut to 300 characters", () => {
	const kinds = (message, options) => classifySyncError(new Error(message), options).class;
	assert.equal(kinds("IMAP sign-in failed: NO [AUTHENTICATIONFAILED] Invalid credentials"), "auth");
	assert.equal(kinds("IMAP sign-in failed: NO [ALERT] Please log in via your web browser"), "auth");
	assert.equal(kinds("IMAP sign-in failed: NO [ALERT] Application-specific password required"), "auth");
	assert.equal(kinds("IMAP sign-in failed: NO [THROTTLED] Too many logins"), "throttled");
	assert.equal(kinds("IMAP command failed: NO [LIMIT] Bandwidth"), "throttled");
	assert.equal(kinds("Too many simultaneous connections"), "throttled");
	assert.equal(kinds("IMAP sign-in failed: NO [UNAVAILABLE] Maintenance"), "transient");
	assert.equal(kinds("The IMAP server did not answer in time"), "transient");
	assert.equal(kinds("IMAP connection closed unexpectedly"), "transient");
	assert.equal(kinds("connect ECONNREFUSED 1.2.3.4:993"), "transient");
	assert.equal(kinds("Something odd"), "transient");
	assert.equal(kinds("IMAP command failed: NO [NONEXISTENT] No such folder"), "config");
	assert.equal(kinds("Private and local mail servers are not allowed", { refused: true }), "config");
	assert.equal(kinds("The IMAP server refused to start TLS", { refused: true }), "config");
	// A name that does not resolve right now is a retry, even though the guard refused it.
	assert.equal(kinds("Kite could not find the mail server imap.example.test", { refused: true }), "transient");
	const tls = classifySyncError(new Error("certificate has expired"), { host: "imap.example.test" });
	assert.equal(tls.class, "tls");
	assert.match(tls.message, /^The server's certificate is not valid for imap\.example\.test\./);
	assert.equal(classifySyncError(new Error("self signed certificate")).message, "self signed certificate");
	const secret = classifySyncError(new Error("IMAP sign-in failed: NO hunter2 rejected"), { secrets: ["hunter2"] });
	assert.doesNotMatch(secret.message, /hunter2/);
	assert.equal(classifySyncError(new Error("x".repeat(500))).message.length, 300);
	assert.equal(classifySyncError("not an error").message, "The connection failed");
	assert.equal(shortServerText("a\r\nb\u0000c"), "a b c");
	assert.ok(new MailServerRefusedError("x") instanceof Error);
});

test("backoff doubles from the interval (15 minutes when throttled), caps at 6 hours and jitters ±20%", () => {
	const minutes = (ms) => ms / 60_000;
	assert.equal(minutes(failureDelayMs("transient", 5, 1, 0.5)), 10);
	assert.equal(minutes(failureDelayMs("transient", 5, 3, 0.5)), 40);
	assert.equal(minutes(failureDelayMs("transient", 5, 1, 0)), 8);
	assert.equal(minutes(failureDelayMs("transient", 5, 1, 0.999999)), 12);
	assert.equal(minutes(failureDelayMs("throttled", 5, 1, 0.5)), 15);
	assert.equal(minutes(failureDelayMs("throttled", 60, 2, 0.5)), 30);
	assert.equal(failureDelayMs("transient", 60, 30, 1), MAX_SYNC_BACKOFF_MS);
	assert.ok(failureDelayMs("transient", 60, 30, 0) >= MAX_SYNC_BACKOFF_MS * 0.8);
	assert.equal(minutes(failureDelayMs("transient", 5, 0, 0.5)), 10, "the first failure counts as one");
	assert.equal(minutes(failureDelayMs("transient", 5, 1, -3)), 8, "random is clamped");
	const now = new Date("2026-10-29T12:00:00Z");
	assert.equal(nextRegularSync(now, 15).toISOString(), "2026-10-29T12:15:00.000Z");
	assert.equal(nextRegularSync(now, 1).toISOString(), "2026-10-29T12:05:00.000Z");
});

test("a failure stops sync for sign-in, certificate and configuration problems and retries the others", () => {
	const now = new Date("2026-10-29T12:00:00Z");
	const healthy = {
		status: "active",
		syncIntervalMinutes: 5,
		consecutiveFailures: 0,
		lastSuccessAt: new Date("2026-10-29T11:55:00Z"),
		createdAt: new Date("2026-10-01T00:00:00Z"),
	};
	const auth = syncFailureUpdate(healthy, { class: "auth", message: "Sign-in failed" }, now, 0.5);
	assert.deepEqual(auth, {
		status: "auth_failed",
		statusReason: "sync",
		lastError: "Sign-in failed",
		consecutiveFailures: 1,
		nextSyncAt: null,
	});
	assert.equal(syncFailureUpdate(healthy, { class: "tls", message: "x" }, now, 0.5).status, "tls_failed");
	const config = syncFailureUpdate(healthy, { class: "config", message: "No such folder" }, now, 0.5);
	assert.deepEqual([config.status, config.statusReason, config.nextSyncAt], ["error", "config", null]);
	const throttled = syncFailureUpdate(healthy, { class: "throttled", message: "x" }, now, 0.5);
	assert.deepEqual([throttled.status, throttled.statusReason], ["active", "throttled"]);
	assert.equal(throttled.nextSyncAt.toISOString(), "2026-10-29T12:15:00.000Z");
	// A day of failures, three or more in a row: `error`, and Kite tries every 6 hours.
	const longFailing = { ...healthy, consecutiveFailures: 5, lastSuccessAt: new Date("2026-10-28T11:00:00Z") };
	const error = syncFailureUpdate(longFailing, { class: "transient", message: "x" }, now, 0.5);
	assert.deepEqual([error.status, error.statusReason, error.consecutiveFailures], ["error", "transient", 6]);
	assert.equal(error.nextSyncAt.toISOString(), "2026-10-29T18:00:00.000Z");
	// Never checked successfully: counted from when the account was connected.
	const never = { ...healthy, consecutiveFailures: 2, lastSuccessAt: null };
	assert.equal(syncFailureUpdate(never, { class: "transient", message: "x" }, now, 0.5).status, "error");
	const fresh = { ...never, createdAt: new Date("2026-10-29T11:00:00Z") };
	assert.equal(syncFailureUpdate(fresh, { class: "transient", message: "x" }, now, 0.5).status, "active");

	assert.equal(isSyncStateChange(healthy, throttled), true, "the first failure is a change");
	assert.equal(isSyncStateChange({ status: "active", consecutiveFailures: 2 }, throttled), false);
	assert.equal(isSyncStateChange({ status: "active", consecutiveFailures: 5 }, error), true);
});

test("only the topmost Authentication-Results with the preset's own authserv-id is trusted", () => {
	const google = "mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=a@example.org; dmarc=pass";
	assert.equal(externalAuthenticationResults([google, "evil.example; spf=pass"], "mx.google.com"), google);
	assert.equal(
		externalAuthenticationResults(["MX.Google.com;   spf=pass"], "mx.google.com"),
		"MX.Google.com; spf=pass",
	);
	// A sender's own copy further down never counts, nor a topmost copy of another hop.
	assert.equal(externalAuthenticationResults(["evil.example; spf=pass", google], "mx.google.com"), null);
	assert.equal(externalAuthenticationResults(["mx.google.com.evil.example; spf=pass"], "mx.google.com"), null);
	// Presets without an authserv-id (custom hosts, Microsoft) get none, and nor does an unreadable header block.
	assert.equal(externalAuthenticationResults([google], null), null);
	assert.equal(externalAuthenticationResults(null, "mx.google.com"), null);
	assert.equal(externalAuthenticationResults([], "mx.google.com"), null);
});

test("a restore drops the account of messages whose connected account is not restored with them", () => {
	const tables = [
		{ name: "external_accounts", rows: [{ id: "xacct_kept" }], columns: null },
		{
			name: "messages",
			rows: [
				{ id: "m1", external_account_id: "xacct_kept" },
				{ id: "m2", external_account_id: "xacct_gone" },
				{ id: "m3", external_account_id: null },
				{ id: "m4" },
			],
			columns: null,
		},
		{ name: "contacts", rows: [{ id: "c1", external_account_id: "xacct_gone" }], columns: null },
	];
	const restored = detachMissingExternalAccounts(tables);
	assert.deepEqual(restored[1].rows, [
		{ id: "m1", external_account_id: "xacct_kept" },
		{ id: "m2", external_account_id: null },
		{ id: "m3", external_account_id: null },
		{ id: "m4" },
	]);
	assert.equal(restored[2], tables[2], "other tables are untouched");
	assert.equal(tables[1].rows[1].external_account_id, "xacct_gone", "the input is not changed");
	// No accounts table in the plan (a database before migration 0079): every link is dropped.
	const withoutAccounts = detachMissingExternalAccounts([tables[1]]);
	assert.equal(withoutAccounts[0].rows[0].external_account_id, null);
});

test("the sidebar notice names failed sign-ins first", () => {
	assert.deepEqual(parseAttentionAccounts(null), []);
	assert.deepEqual(parseAttentionAccounts({ accounts: "x" }), []);
	const accounts = parseAttentionAccounts({
		accounts: [
			{ id: "a", address: "a@gmail.com", status: "error" },
			{ id: "b", address: "b@gmail.com", status: "auth_failed" },
			{ id: 3, address: "c@gmail.com", status: "error" },
			null,
		],
	});
	assert.deepEqual(
		accounts.map((account) => account.id),
		["a", "b"],
	);
	assert.deepEqual(connectedAccountsBannerContent(accounts), {
		title: "Sign-in failed for b@gmail.com",
		body: "Reconnect to keep its new mail arriving in Kite.",
	});
	assert.equal(
		connectedAccountsBannerContent([...accounts, { id: "c", address: "c@x.test", status: "auth_failed" }]).title,
		"Sign-in failed for 2 accounts",
	);
	assert.equal(connectedAccountsBannerContent([accounts[0]]).title, "Kite cannot check a@gmail.com");
	assert.equal(
		connectedAccountsBannerContent([accounts[0], { ...accounts[0], id: "z" }]).title,
		"Kite cannot check 2 connected accounts",
	);
});

test("the account list says where checking stands", () => {
	const now = new Date("2026-10-29T12:00:00Z");
	const time = (iso) => iso.slice(11, 16);
	const account = (status, sync, extra = {}) => ({
		status,
		hasPassword: true,
		lastError: null,
		imap: { host: "imap.example.test" },
		sync: {
			enabled: true,
			intervalMinutes: 5,
			lastSuccessAt: "2026-10-29T11:58:00Z",
			nextSyncAt: "2026-10-29T12:03:00Z",
			failures: 0,
			problem: null,
			running: false,
			...sync,
		},
		...extra,
	});
	assert.equal(syncStatusText(account("active", {}), now, time), "Checked 2 minutes ago · next check at 12:03");
	assert.equal(syncStatusText(account("active", { nextSyncAt: null }), now, time), "Checked 2 minutes ago");
	assert.equal(
		syncStatusText(account("active", { lastSuccessAt: null }), now, time),
		"Kite checks for new mail within five minutes.",
	);
	assert.equal(syncStatusText(account("active", { running: true }), now, time), "Checking for new mail…");
	assert.equal(
		syncStatusText(account("active", { enabled: false }), now, time),
		"Checking for new mail is paused.",
	);
	assert.equal(
		syncStatusText(account("active", { problem: "throttled", failures: 1, nextSyncAt: "2026-10-29T14:35:00Z" }), now, time),
		"The provider is limiting connections; Kite will try again at 14:35.",
	);
	assert.equal(
		syncStatusText(account("active", { problem: "transient", failures: 2 }), now, time),
		"Checked 2 minutes ago · next check at 12:03",
		"two failures are not worth a word yet",
	);
	assert.equal(
		syncStatusText(account("active", { problem: "transient", failures: 3, lastSuccessAt: "2026-10-29T09:10:00Z" }), now, time),
		"Could not reach imap.example.test since 09:10; retrying.",
	);
	assert.equal(
		syncStatusText(account("error", { problem: "transient", lastSuccessAt: null }), now, time),
		"Could not reach imap.example.test; Kite tries again every 6 hours.",
	);
	assert.equal(
		syncStatusText(account("error", { problem: "config" }, { lastError: "No such folder" }), now, time),
		"No such folder",
	);
	assert.equal(
		syncStatusText(account("error", { problem: "config" }), now, time),
		"Checking stopped. Edit the account to fix it.",
	);
	assert.equal(syncStatusText(account("auth_failed", {}), now, time), null);
	assert.equal(canCheckNow(account("active", {})), true);
	assert.equal(canCheckNow(account("error", {})), true);
	assert.equal(canCheckNow(account("active", { enabled: false })), false);
	assert.equal(canCheckNow(account("auth_failed", {})), false);
	assert.equal(canCheckNow(account("active", {}, { hasPassword: false })), false);
	assert.equal(relativeTime("2026-10-29T11:59:45Z", now), "just now");
	assert.equal(relativeTime("2026-10-29T11:59:00Z", now), "1 minute ago");
	assert.equal(relativeTime("2026-10-29T10:00:00Z", now), "2 hours ago");
	assert.equal(relativeTime("2026-10-29T11:00:00Z", now), "1 hour ago");
	assert.match(relativeTime("2026-10-20T10:00:00Z", now), /^on /);
	assert.equal(typeof syncStatusText(account("active", {}), now), "string", "the default clock format works");
});
