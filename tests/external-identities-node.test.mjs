import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

// Send-as verification codes (docs/specs/external-accounts.md §7.2, §10.3; PR 11) on SQLite: the code mail goes only
// to the address being verified, the code is random, hashed at rest, single-use, short-lived and limited to five
// tries; code mails are limited per user and per address; an address is sent as only once verified, and no longer
// once removed; and the pure rules around them.

const {
	SqliteDatabase,
	applyMigrations,
	hashPassword,
	addExternalIdentity,
	resendExternalIdentityCode,
	verifyExternalIdentity,
	removeExternalIdentity,
	resolveSendIdentity,
	listSendIdentities,
	isOwnConnectedAddress,
	readIdentities,
	generateIdentityCode,
	normalizeIdentityCode,
	parseIdentityAddress,
	parseIdentityName,
	hashIdentityCode,
	sameCodeHash,
	identityState,
	identityCodeMail,
	IDENTITY_CODE_TTL_MS,
	MAX_CODE_ATTEMPTS,
	CODES_PER_ADDRESS,
	CODES_PER_USER,
	CODES_PER_ADDRESS_PER_DAY,
	MAX_FAILED_CODES_PER_DAY,
	sendViaSubmission,
	serializeExternalAccount,
	redactBackupRow,
	restoredBackupRow,
	senderOptionLabel,
	ownAddressVerification,
	aliasesOf,
} = await bundleModules("kite-external-identities-node-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["hashPassword", "src/lib/auth/password.ts"],
	[
		"addExternalIdentity, resendExternalIdentityCode, verifyExternalIdentity, removeExternalIdentity",
		"src/lib/external-accounts/identity-verification.ts",
	],
	["resolveSendIdentity, listSendIdentities, isOwnConnectedAddress", "src/lib/external-accounts/identities.ts"],
	["readIdentities", "src/lib/external-accounts/identity-store.ts"],
	[
		"generateIdentityCode, normalizeIdentityCode, parseIdentityAddress, parseIdentityName, hashIdentityCode, sameCodeHash, identityState, identityCodeMail, IDENTITY_CODE_TTL_MS, MAX_CODE_ATTEMPTS, CODES_PER_ADDRESS, CODES_PER_USER, CODES_PER_ADDRESS_PER_DAY, MAX_FAILED_CODES_PER_DAY",
		"src/lib/external-accounts/identity-code-utils.ts",
	],
	["serializeExternalAccount", "src/lib/external-accounts/serialize-utils.ts"],
	["sendViaSubmission", "src/lib/external-accounts/submit.ts"],
	["redactBackupRow, restoredBackupRow", "src/lib/backups/external-accounts-utils.ts"],
	["senderOptionLabel", "src/components/compose/sender-options-utils.ts"],
	["ownAddressVerification, aliasesOf", "src/components/settings/connected-accounts/account-addresses-utils.ts"],
]);

const KEY = "test-only-invented-encryption-key-0123456789abcdef";
const KITE_PASSWORD = "kite-password-1";
const ALIAS = "alias@elsewhere.test";

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

/**
 * A database with two users, an "Other" account of the owner (its address unproven, its SMTP sign-in tested), a
 * Gmail account whose sign-in proves its address, and a Kite domain that can send system mail. `sent` collects what
 * the send binding was given.
 */
async function setup(t, { migrate = true } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	if (!migrate) db.db.exec("DROP TABLE external_identities");
	const hash = hashPassword(KITE_PASSWORD);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.com', '${hash}', 'Owner', 'admin', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', '${hash}', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 'cloudflare', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-b', 'other', 'domain-1', 'b', 'personal', 1);
		INSERT INTO external_accounts (id, user_id, mailbox_id, label, address, display_name, preset, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username, secret, smtp_verified_at, created_at, updated_at)
			VALUES ('xacct-other', 'owner', 'mailbox-a', 'Own server', 'me@own.test', 'Pat', 'other', 'imap.own.test', 993, 'tls', 'smtp.own.test', 465, 'tls', 'me@own.test', 'enc:v1:x:y', 1, 1, 1);
		INSERT INTO external_accounts (id, user_id, mailbox_id, label, address, preset, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username, secret, smtp_verified_at, created_at, updated_at)
			VALUES ('xacct-gmail', 'owner', 'mailbox-a', 'Gmail', 'me@gmail.com', 'gmail', 'imap.gmail.com', 993, 'tls', 'smtp.gmail.com', 465, 'tls', 'me@gmail.com', 'enc:v1:x:y', 1, 1, 1);
		INSERT INTO external_accounts (id, user_id, mailbox_id, label, address, preset, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username, secret, smtp_verified_at, created_at, updated_at)
			VALUES ('xacct-theirs', 'other', 'mailbox-b', 'Theirs', 'them@own.test', 'other', 'imap.own.test', 993, 'tls', 'smtp.own.test', 465, 'tls', 'them@own.test', 'enc:v1:x:y', 1, 1, 1);
	`);
	const sent = [];
	const env = {
		KITE_RUNTIME: "node",
		APP_ENCRYPTION_KEY: KEY,
		DB: db,
		EMAIL: {
			send: async (message) => {
				sent.push(message);
				return { messageId: `<sent-${sent.length}@example.com>` };
			},
		},
	};
	globalThis.__kiteNodeEnv = env;
	return { db, env, sent };
}

const owner = { id: "owner", role: "admin", passwordHash: hashPassword(KITE_PASSWORD) };
const other = { id: "other", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };

async function refusal(promise) {
	try {
		await promise;
	} catch (error) {
		return { status: error.status, code: error.code, message: error.message };
	}
	assert.fail("expected a refusal");
}

const codeIn = (message) => /verification code is (\d{6})/.exec(message.text)?.[1];
const identityRow = (db, id) => db.db.prepare("SELECT * FROM external_identities WHERE id = ?").get(id);
const auditActions = (db) =>
	db.db
		.prepare("SELECT action FROM audit_logs WHERE action LIKE 'external_identity.%' ORDER BY created_at, rowid")
		.all()
		.map((row) => row.action);

test("codes are six uniform digits, normalized as typed, and hashed with the key and the identity", async () => {
	for (let i = 0; i < 50; i++) assert.match(generateIdentityCode(), /^\d{6}$/);
	// A draw above the largest multiple of a million is thrown away rather than folded onto low codes.
	const draws = [0xffffffff, 42];
	assert.equal(
		generateIdentityCode((bytes) => {
			bytes[0] = draws.shift();
			return bytes;
		}),
		"000042",
	);
	assert.equal(normalizeIdentityCode(" 123 456 "), "123456");
	assert.equal(normalizeIdentityCode("123-456"), "123456");
	for (const bad of ["12345", "1234567", "abcdef", 123456, null]) assert.equal(normalizeIdentityCode(bad), null);
	const hash = await hashIdentityCode(KEY, "xid_1", "123456");
	assert.match(hash, /^[0-9a-f]{64}$/);
	assert.notEqual(hash, await hashIdentityCode(KEY, "xid_2", "123456"), "bound to the identity");
	assert.notEqual(hash, await hashIdentityCode(`${KEY}x`, "xid_1", "123456"), "bound to the key");
	assert.equal(sameCodeHash(hash, await hashIdentityCode(KEY, "xid_1", "123456")), true);
	assert.equal(sameCodeHash(hash, hash.slice(1)), false);
	await assert.rejects(hashIdentityCode("", "xid_1", "123456"));
});

test("only one plain address can be verified, and the code mail is a fixed text", () => {
	assert.equal(parseIdentityAddress(" Alias@Elsewhere.TEST "), ALIAS);
	for (const bad of [
		"a@b",
		"two@a.test, three@b.test",
		"Name <a@b.test>",
		"a@b.test\r\nBcc: c@d.test",
		"a..b@c.test",
		".a@c.test",
		"a@-c.test",
		`${"a".repeat(65)}@c.test`,
		42,
	])
		assert.equal(parseIdentityAddress(bad), null, String(bad));
	assert.equal(parseIdentityName("  Pat\r\nBcc: x "), "Pat Bcc: x");
	assert.equal(parseIdentityName(" "), null);
	const mail = identityCodeMail("a&b@c.test", "012345");
	assert.equal(mail.subject, "Your Kite verification code");
	assert.ok(!mail.subject.includes("012345"), "the code is not in the subject");
	assert.match(mail.text, /verification code is 012345\./);
	assert.match(mail.html, /a&#38;b@c\.test/);
	assert.ok(!mail.html.includes("a&b@"));
});

test("an address waits for its code until entered; an expired code needs a new one", () => {
	const now = new Date(10_000);
	assert.equal(identityState({ verifiedAt: new Date(1), codeHash: null, codeExpiresAt: null }, now), "verified");
	assert.equal(identityState({ verifiedAt: null, codeHash: "h", codeExpiresAt: new Date(20_000) }, now), "pending");
	assert.equal(identityState({ verifiedAt: null, codeHash: "h", codeExpiresAt: new Date(5_000) }, now), "unverified");
	assert.equal(identityState({ verifiedAt: null, codeHash: null, codeExpiresAt: null }, now), "unverified");
});

test("a code is mailed only to the address, stored as an HMAC, and verifies it once", async (t) => {
	const { db, env, sent } = await setup(t);
	assert.equal(await resolveSendIdentity(env, { userId: "owner", mailboxId: "mailbox-a", address: ALIAS }), null);

	const { identityId, account } = await addExternalIdentity(env, owner, "xacct-other", { address: ALIAS });
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].to, [ALIAS], "the only recipient is the address being verified");
	assert.ok(!sent[0].cc?.length && !sent[0].bcc?.length);
	assert.equal(sent[0].headers["Auto-Submitted"], "auto-generated");
	const code = codeIn(sent[0]);
	assert.match(code, /^\d{6}$/);
	const row = identityRow(db, identityId);
	assert.match(row.code_hash, /^[0-9a-f]{64}$/);
	assert.ok(!row.code_hash.includes(code));
	assert.ok(Math.abs(row.code_expires_at * 1000 - (Date.now() + IDENTITY_CODE_TTL_MS)) < 60_000, "30 minutes");
	assert.deepEqual(
		account.identities.map(({ address, state, accountAddress }) => ({ address, state, accountAddress })),
		[{ address: ALIAS, state: "pending", accountAddress: false }],
	);
	assert.ok(!JSON.stringify(account).includes(row.code_hash), "the hash never leaves the server");
	// Not offered as From before the code.
	assert.equal(await resolveSendIdentity(env, { userId: "owner", mailboxId: "mailbox-a", address: ALIAS }), null);
	assert.equal(await isOwnConnectedAddress(env, "owner", ALIAS), true);
	assert.equal(await isOwnConnectedAddress(env, "other", ALIAS), false);

	const wrong = code === "000000" ? "111111" : "000000";
	assert.equal(
		(await refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: wrong }))).code,
		"CODE_WRONG",
	);
	const { account: verified } = await verifyExternalIdentity(env, owner, "xacct-other", identityId, { code });
	assert.equal(verified.identities[0].state, "verified");
	const after = identityRow(db, identityId);
	assert.ok(after.verified_at);
	assert.deepEqual([after.code_hash, after.code_expires_at, after.attempts], [null, null, 0], "single use");

	assert.deepEqual(
		await resolveSendIdentity(env, { userId: "owner", mailboxId: "mailbox-a", address: "Alias@Elsewhere.test" }),
		{
			accountId: "xacct-other",
			address: ALIAS,
			displayName: "Pat",
			sendLimit: null,
		},
	);
	// Only the owner, and only from the mailbox the account delivers into.
	assert.equal(await resolveSendIdentity(env, { userId: "other", mailboxId: "mailbox-a", address: ALIAS }), null);
	assert.equal(await resolveSendIdentity(env, { userId: "owner", mailboxId: "mailbox-b", address: ALIAS }), null);
	const listed = (await listSendIdentities(env, "owner")).get("mailbox-a");
	assert.ok(listed.some((identity) => identity.address === ALIAS && identity.available));

	assert.equal(
		(await refusal(addExternalIdentity(env, owner, "xacct-other", { address: ALIAS }))).code,
		"ALREADY_VERIFIED",
	);
	await removeExternalIdentity(env, owner, "xacct-other", identityId);
	assert.equal(await resolveSendIdentity(env, { userId: "owner", mailboxId: "mailbox-a", address: ALIAS }), null);
	assert.deepEqual(auditActions(db), [
		"external_identity.code_attempted",
		"external_identity.code_requested",
		"external_identity.verify_failed",
		"external_identity.verified",
		"external_identity.revoked",
	]);
	const metadata = db.db.prepare("SELECT metadata FROM audit_logs WHERE action LIKE 'external_identity.%'").all();
	for (const { metadata: text } of metadata) assert.ok(!text.includes(code), "the code is never audited");
});

test("an Other account's own address is sent as only after its code", async (t) => {
	const { env, sent } = await setup(t);
	const own = { userId: "owner", mailboxId: "mailbox-a", address: "me@own.test" };
	await assert.rejects(resolveSendIdentity(env, own), /Verify this address with a code/);
	const listed = (await listSendIdentities(env, "owner")).get("mailbox-a");
	assert.deepEqual(
		listed.find((identity) => identity.address === "me@own.test"),
		{
			accountId: "xacct-other",
			address: "me@own.test",
			displayName: "Pat",
			presetLabel: "Other IMAP provider",
			available: false,
			action: "verify",
			hint: "Verify this address with a code under Settings → Connected accounts to send from it.",
		},
	);
	assert.equal(
		senderOptionLabel({ address: "me@own.test", identity: { action: "verify" } }),
		"me@own.test (Verify in Settings)",
	);

	const { identityId, account } = await addExternalIdentity(env, owner, "xacct-other", { address: "me@own.test" });
	assert.deepEqual(sent[0].to, ["me@own.test"]);
	assert.equal(account.sending.block, "unproven");
	assert.deepEqual(ownAddressVerification(account), { identity: account.identities[0] });
	assert.deepEqual(aliasesOf(account), []);
	const { account: verified } = await verifyExternalIdentity(env, owner, "xacct-other", identityId, {
		code: codeIn(sent[0]),
	});
	assert.equal(verified.sending.block, null);
	assert.equal(ownAddressVerification(verified), null);
	assert.equal((await resolveSendIdentity(env, own)).accountId, "xacct-other");

	// A known provider's address is proven by its sign-in: no code.
	assert.equal(
		(await refusal(addExternalIdentity(env, owner, "xacct-gmail", { address: "me@gmail.com" }))).code,
		"NO_CODE_NEEDED",
	);
});

test("five wrong codes drop the code; an expired code is refused; a new code replaces the old", async (t) => {
	const { db, env, sent } = await setup(t);
	const { identityId } = await addExternalIdentity(env, owner, "xacct-other", { address: ALIAS });
	const code = codeIn(sent[0]);
	const wrong = code === "000000" ? "111111" : "000000";
	for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
		const answer = await refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: wrong }));
		assert.equal(answer.code, "CODE_WRONG");
		assert.equal(answer.status, 400);
	}
	assert.equal(identityRow(db, identityId).code_hash, null, "the code is gone after the last try");
	assert.equal(
		(await refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code }))).code,
		"CODE_EXPIRED",
		"the right code no longer works either",
	);

	await resendExternalIdentityCode(env, owner, "xacct-other", identityId);
	const second = codeIn(sent[1]);
	assert.deepEqual(sent[1].to, [ALIAS]);
	db.db
		.prepare("UPDATE external_identities SET code_expires_at = ? WHERE id = ?")
		.run(Math.floor(Date.now() / 1000) - 1, identityId);
	assert.equal(
		(await refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: second }))).code,
		"CODE_EXPIRED",
	);
	await resendExternalIdentityCode(env, owner, "xacct-other", identityId);
	const third = codeIn(sent[2]);
	if (second !== third)
		assert.equal(
			(await refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: second }))).code,
			"CODE_WRONG",
			"an earlier code stops working",
		);
	await verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: third });
	assert.ok(identityRow(db, identityId).verified_at);
	assert.equal(
		(await refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: "12345" }))).status,
		400,
	);
});

test("parallel guesses never get past the attempt limit", async (t) => {
	const { db, env, sent } = await setup(t);
	const { identityId } = await addExternalIdentity(env, owner, "xacct-other", { address: ALIAS });
	const code = codeIn(sent[0]);
	const guesses = Array.from({ length: 20 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"));
	const answers = await Promise.all(
		guesses.map((guess) => refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: guess }))),
	);
	assert.equal(answers.filter((answer) => answer.code === "CODE_WRONG").length, MAX_CODE_ATTEMPTS);
	assert.ok(identityRow(db, identityId).attempts <= MAX_CODE_ATTEMPTS);
});

const addAuditRows = (db, action, address, n, actor = "other") => {
	const insert = db.db.prepare(
		"INSERT INTO audit_logs (id, actor_user_id, action, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	for (let i = 0; i < n; i++)
		insert.run(
			`aud-${action}-${i}-${Math.random()}`,
			actor,
			action,
			JSON.stringify({ address }),
			Math.floor(Date.now() / 1000),
		);
};

test("code mails are limited per user, per user and address, and per address a day", async (t) => {
	const { db, env, sent } = await setup(t);
	const { identityId } = await addExternalIdentity(env, owner, "xacct-other", { address: ALIAS });
	for (let i = 1; i < CODES_PER_ADDRESS; i++) await resendExternalIdentityCode(env, owner, "xacct-other", identityId);
	const limited = await refusal(resendExternalIdentityCode(env, owner, "xacct-other", identityId));
	assert.deepEqual([limited.status, limited.code], [429, "RATE_LIMITED"]);
	assert.equal(sent.length, CODES_PER_ADDRESS);
	// Another user's requests for the same address do not count against the owner's hour, nor the owner's against theirs.
	await addExternalIdentity(env, other, "xacct-theirs", { address: ALIAS });
	assert.equal(sent.length, CODES_PER_ADDRESS + 1);

	// The user's own budget counts every request first, and a request refused there is not counted against the address.
	db.db.exec("DELETE FROM audit_logs");
	for (let i = 0; i < CODES_PER_USER; i++)
		await addExternalIdentity(env, owner, "xacct-other", { address: `alias${i}@elsewhere.test` });
	assert.equal((await refusal(resendExternalIdentityCode(env, owner, "xacct-other", identityId))).status, 429);
	const aboutAlias = db.db
		.prepare(
			"SELECT count(*) AS n FROM audit_logs WHERE action = 'external_identity.code_requested' AND metadata LIKE ?",
		)
		.get(`%"${ALIAS}"%`).n;
	assert.equal(aboutAlias, 0, "refused by the user limit, it never reached the address count");

	// Per address a day, whoever asks.
	db.db.exec("DELETE FROM audit_logs");
	addAuditRows(db, "external_identity.code_requested", ALIAS, CODES_PER_ADDRESS_PER_DAY);
	assert.match((await refusal(resendExternalIdentityCode(env, owner, "xacct-other", identityId))).message, /today/);
});

test("an address that collected ten wrong codes in a day gets no new code or try", async (t) => {
	const { db, env, sent } = await setup(t);
	const { identityId } = await addExternalIdentity(env, owner, "xacct-other", { address: ALIAS });
	const code = codeIn(sent[0]);
	addAuditRows(db, "external_identity.verify_failed", ALIAS, MAX_FAILED_CODES_PER_DAY);
	const tries = await refusal(verifyExternalIdentity(env, owner, "xacct-other", identityId, { code }));
	assert.deepEqual([tries.status, tries.code], [429, "RATE_LIMITED"]);
	assert.equal(identityRow(db, identityId).attempts, 0, "no attempt was taken");
	assert.equal((await refusal(resendExternalIdentityCode(env, owner, "xacct-other", identityId))).status, 429);
	assert.equal(sent.length, 1);
});

test("a send waiting for an alias that was removed fails when it runs", async (t) => {
	const { db, env, sent } = await setup(t);
	const { identityId } = await addExternalIdentity(env, owner, "xacct-other", { address: ALIAS });
	await verifyExternalIdentity(env, owner, "xacct-other", identityId, { code: codeIn(sent[0]) });
	assert.equal(
		(await resolveSendIdentity(env, { userId: "owner", mailboxId: "mailbox-a", address: ALIAS })).accountId,
		"xacct-other",
	);
	await removeExternalIdentity(env, owner, "xacct-other", identityId);
	const target = {
		accountId: "xacct-other",
		userId: "owner",
		mailboxId: "mailbox-a",
		messageId: "msg-1",
		jobId: "job-1",
	};
	const message = { from: `Pat <${ALIAS}>`, to: ["friend@example.org"], subject: "Hi", text: "Hi", html: "<p>Hi</p>" };
	const error = await sendViaSubmission(env, target, message).catch((caught) => caught);
	assert.equal(error.name, "SubmissionError");
	assert.equal(error.action, "fail");
	assert.equal(error.message, `Not sent from ${ALIAS}. The address is no longer verified for this account.`);
	// An address the account never verified fails the same way.
	const never = await sendViaSubmission(env, target, { ...message, from: "stranger@elsewhere.test" }).catch((c) => c);
	assert.match(never.message, /^Not sent from stranger@elsewhere\.test\. The address is no longer verified/);
	assert.equal(db.db.prepare("SELECT status FROM external_accounts WHERE id = 'xacct-other'").get().status, "active");
});

test("refused: another user's account, a Kite domain, no SMTP, a list of addresses, no sender, before the migration", async (t) => {
	const { db, env, sent } = await setup(t);
	assert.equal((await refusal(addExternalIdentity(env, other, "xacct-other", { address: ALIAS }))).status, 404);
	assert.equal(
		(await refusal(addExternalIdentity(env, owner, "xacct-other", { address: "x@example.com" }))).code,
		"KITE_DOMAIN",
	);
	assert.equal(
		(await refusal(addExternalIdentity(env, owner, "xacct-other", { address: `${ALIAS}, victim@else.test` }))).status,
		400,
	);
	db.db.exec("UPDATE external_accounts SET smtp_host = NULL WHERE id = 'xacct-other'");
	assert.equal((await refusal(addExternalIdentity(env, owner, "xacct-other", { address: ALIAS }))).code, "NO_SMTP");
	db.db.exec("UPDATE external_accounts SET smtp_host = 'smtp.own.test' WHERE id = 'xacct-other'");
	db.db.exec("UPDATE domains SET sending_provider = 'none'");
	const notSent = await refusal(addExternalIdentity(env, owner, "xacct-other", { address: ALIAS }));
	assert.equal(notSent.code, "CODE_NOT_SENT");
	assert.equal(sent.length, 0);
	const [row] = db.db.prepare("SELECT code_hash FROM external_identities").all();
	assert.equal(row.code_hash, null, "no code is left waiting when its mail did not go out");

	const pending = await setup(t, { migrate: false });
	assert.equal(
		(await refusal(addExternalIdentity(pending.env, owner, "xacct-other", { address: ALIAS }))).code,
		"MIGRATION_PENDING",
	);
	assert.deepEqual(await readIdentities(pending.env, ["xacct-other"]), new Map());
	// Without the table everything answers as before: the known provider's address still sends.
	assert.equal(
		(await resolveSendIdentity(pending.env, { userId: "owner", mailboxId: "mailbox-a", address: "me@gmail.com" }))
			.accountId,
		"xacct-gmail",
	);
});

test("backups keep whether an address was verified, never a pending code", () => {
	const row = {
		id: "xid",
		account_id: "a",
		address: ALIAS,
		verified_at: 5,
		code_hash: "abc",
		code_expires_at: 9,
		attempts: 2,
	};
	assert.deepEqual(redactBackupRow("external_identities", row), {
		...row,
		code_hash: null,
		code_expires_at: null,
		attempts: 0,
	});
	assert.deepEqual(restoredBackupRow("external_identities", row), redactBackupRow("external_identities", row));
	assert.equal(row.code_hash, "abc", "the live row is not changed");
});

test("the account view counts its own verified address as proven, and never shows a code hash", () => {
	const base = {
		id: "x",
		label: "x",
		address: "me@own.test",
		displayName: null,
		preset: "other",
		mailboxId: "m",
		imapHost: "imap.own.test",
		imapPort: 993,
		imapSecurity: "tls",
		smtpHost: "smtp.own.test",
		smtpPort: 465,
		smtpSecurity: "tls",
		username: "me@own.test",
		secret: "enc:v1:abc:def",
		sendEnabled: true,
		status: "active",
		statusReason: null,
		lastError: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const identity = {
		id: "xid",
		address: "me@own.test",
		displayName: null,
		verifiedAt: null,
		codeHash: "secret-hash",
		codeExpiresAt: new Date(Date.now() + 60_000),
	};
	const pending = serializeExternalAccount(base, new Date(1), new Date(), [identity]);
	assert.equal(pending.sending.block, "unproven");
	assert.equal(pending.identities[0].state, "pending");
	assert.ok(!JSON.stringify(pending).includes("secret-hash"));
	const verified = serializeExternalAccount(base, new Date(1), new Date(), [
		{ ...identity, codeHash: null, codeExpiresAt: null, verifiedAt: new Date(2) },
	]);
	assert.equal(verified.sending.block, null);
	assert.equal(verified.identities[0].codeExpiresAt, null);
});
