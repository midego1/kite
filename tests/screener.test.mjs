import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-screener-");
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * Automatic reading is replaced by a recorder: the tests only check what gets scheduled, and bundling the
 * real scheduler would re-bundle gated agent utilities, which the per-file coverage merge reads as extra
 * uncovered functions.
 */
const stubAgentSchedule = {
	name: "stub-agent-schedule",
	setup(build) {
		build.onResolve({ filter: /^@\/lib\/agent\/auto-read\/schedule$/ }, (args) => ({
			path: args.path,
			namespace: "stub",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents:
				"export async function scheduleAgentWork(_env, input) { (globalThis.__screenerScheduled ??= []).push(input.sourceMessageId); }",
			loader: "js",
		}));
	},
};

await build({
	entryPoints: {
		utils: join(root, "src/lib/screener/screener-utils.ts"),
		settings: join(root, "src/lib/screener/settings.ts"),
		inbound: join(root, "src/lib/screener/inbound.ts"),
		emailInbound: join(root, "src/lib/email/inbound.ts"),
		release: join(root, "src/lib/screener/release.ts"),
		service: join(root, "src/lib/screener/service.ts"),
		views: join(root, "src/lib/screener/views.ts"),
		access: join(root, "src/lib/mailboxes/access.ts"),
		db: join(root, "src/db/index.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	plugins: [stubAgentSchedule],
	alias: {
		"cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"),
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
	},
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const utils = await load("utils");
const settings = await load("settings");
const { applyScreener } = await load("inbound");
const { processInboundMessage } = await load("emailInbound");
const { approveSentRecipients } = await load("release");
const service = await load("service");
const views = await load("views");
const { getMailboxAccessLevel } = await load("access");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { getDb } = await load("db");

const owner = { id: "owner", role: "user", isPrimaryAdmin: false, email: "owner@example.com" };
const reader = { id: "reader", role: "user", isPrimaryAdmin: false, email: "reader@example.com" };
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
// Blocking a new contact looks up a Gravatar; nothing leaves the test.
globalThis.fetch = async () => new Response("", { status: 404 });

let count = 0;
async function setup(t, { migrated = true } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('reader', 'reader@example.com', 'hash', 'Reader', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'shared', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-b', 'owner', 'domain-1', 'b', 1);
		INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, created_at) VALUES ('alias-1', 'mailbox-b', 'domain-1', 'sales', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'reader', 'read_only', 1);
	`);
	if (!migrated) database.db.exec("DROP TABLE screener_senders; DROP TABLE screener_settings;");
	const env = { DB: database };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const db = getDb(env);
	const addMessage = (fromAddr, { status = "received", direction = "inbound", mailboxId = "mailbox-a", to } = {}) => {
		const id = `msg-${++count}`;
		database.db
			.prepare(
				"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'owner', ?, ?, ?, ?, 'Hello', 'Hello there', ?, ?)",
			)
			.run(id, mailboxId, direction, fromAddr, to ?? "a@example.com", status, count);
		return id;
	};
	const statusOf = (id) => database.db.prepare("SELECT status FROM messages WHERE id = ?").get(id).status;
	const access = async (user = owner, mailboxId = "mailbox-a") => getMailboxAccessLevel(db, user, mailboxId);
	return { database, env, db, addMessage, statusOf, access };
}

test("addresses are lowercased bare addresses, and anything else is refused", () => {
	assert.equal(utils.screenerAddress("Jane Doe <Jane@Example.TEST>"), "jane@example.test");
	assert.equal(utils.screenerAddress("  bob@partner.test "), "bob@partner.test");
	assert.equal(utils.screenerAddress("not an address"), null);
	assert.equal(utils.screenerAddress("a@b"), null);
	assert.equal(utils.screenerAddress(42), null);
	assert.deepEqual(
		utils.recipientAddresses("Jane <jane@partner.test>, bob@partner.test", ["BOB@partner.test", "x"], null, undefined),
		["jane@partner.test", "bob@partner.test"],
	);
});

test("bounces, system mail and the install's own addresses are never screened", () => {
	const own = new Set(["a@example.com"]);
	assert.equal(utils.isScreenerExempt(null, own), true);
	assert.equal(utils.isScreenerExempt("mailer-daemon@partner.test", own), true);
	assert.equal(utils.isScreenerExempt("postmaster@partner.test", own), true);
	assert.equal(utils.isScreenerExempt("a@example.com", own), true);
	assert.equal(utils.isScreenerExempt("jane@partner.test", own), false);
});

test("the verdict screens only mail headed for the Inbox or a folder, from undecided senders", () => {
	const on = { enabled: true, mode: "screener" };
	const base = { settings: on, status: "received", sender: "jane@partner.test", exempt: false, decision: null };
	assert.equal(utils.screenerVerdict(base), "hold");
	assert.equal(utils.screenerVerdict({ ...base, settings: { enabled: true, mode: "inbox" } }), "mark");
	assert.equal(utils.screenerVerdict({ ...base, decision: "approved" }), "deliver");
	assert.equal(utils.screenerVerdict({ ...base, decision: "denied" }), "spam");
	assert.equal(utils.screenerVerdict({ ...base, settings: null }), "deliver");
	assert.equal(utils.screenerVerdict({ ...base, settings: { enabled: false, mode: "screener" } }), "deliver");
	assert.equal(utils.screenerVerdict({ ...base, status: "spam" }), "deliver");
	assert.equal(utils.screenerVerdict({ ...base, exempt: true }), "deliver");
	assert.equal(utils.screenerVerdict({ ...base, sender: null }), "deliver");
});

test("request bodies are validated before anything is written", () => {
	assert.deepEqual(utils.parseScreenerSettingsPatch(null), { ok: false, error: "Mailbox is required" });
	assert.deepEqual(utils.parseScreenerSettingsPatch([]), { ok: false, error: "Mailbox is required" });
	assert.equal(utils.parseScreenerSettingsPatch({ mailboxId: "m", enabled: "yes" }).ok, false);
	assert.equal(utils.parseScreenerSettingsPatch({ mailboxId: "m", mode: "folder" }).ok, false);
	assert.equal(utils.parseScreenerSettingsPatch({ mailboxId: "m" }).error, "No changes requested");
	assert.deepEqual(utils.parseScreenerSettingsPatch({ mailboxId: "m", enabled: true, mode: "inbox" }), {
		ok: true,
		value: { mailboxId: "m", enabled: true, mode: "inbox" },
	});

	assert.equal(utils.parseScreenerSenderRequest({ address: "a@b.test" }).ok, false);
	assert.equal(utils.parseScreenerSenderRequest({ mailboxId: "m", address: "nope" }).error, "Enter one email address");
	assert.equal(utils.parseScreenerSenderRequest({ mailboxId: "m", address: "a@b.test", decision: "maybe" }).ok, false);
	assert.deepEqual(utils.parseScreenerSenderRequest({ mailboxId: "m", address: "A@B.test", decision: "denied" }), {
		ok: true,
		value: { mailboxId: "m", address: "a@b.test", decision: "denied" },
	});

	assert.equal(utils.parseScreenerSenderRemoval({}).ok, false);
	assert.equal(utils.parseScreenerSenderRemoval({ mailboxId: "m", address: "" }).ok, false);
	assert.deepEqual(
		utils.parseScreenerSenderRemoval({ mailboxId: "m", address: "a@b.test" }).value.restoreMessageIds,
		[],
	);
	assert.deepEqual(
		utils.parseScreenerSenderRemoval({ mailboxId: "m", address: "a@b.test", restoreMessageIds: ["x", 3, "", "y"] })
			.value.restoreMessageIds,
		["x", "y"],
	);
});

test("a row is a new sender when held, or undecided in an Inbox-mode mailbox", () => {
	const row = { status: "received", direction: "inbound", fromAddr: "Jane <jane@partner.test>" };
	const own = new Set(["a@example.com"]);
	assert.equal(utils.isNewSenderRow({ ...row, status: "screening" }, false, new Set(), own), true);
	assert.equal(utils.isNewSenderRow(row, false, new Set(), own), false);
	assert.equal(utils.isNewSenderRow(row, true, new Set(), own), true);
	assert.equal(utils.isNewSenderRow(row, true, new Set(["jane@partner.test"]), own), false);
	assert.equal(utils.isNewSenderRow({ ...row, direction: "outbound" }, true, new Set(), own), false);
	assert.equal(utils.isNewSenderRow({ ...row, fromAddr: "a@example.com" }, true, new Set(), own), false);
});

test("delivery holds undecided senders, delivers approved ones and files denied ones as spam", async (t) => {
	const { db } = await setup(t);
	const deliver = (sender, status = "received", mailboxId = "mailbox-a") =>
		applyScreener(db, { mailboxId, sender, status });
	assert.deepEqual(await deliver("jane@partner.test"), { status: "received", awaiting: false }, "off by default");

	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	assert.deepEqual(await settings.getScreenerSettings(db, "mailbox-a"), { enabled: true, mode: "screener" });
	assert.deepEqual(await deliver("Jane <Jane@partner.test>"), { status: "screening", awaiting: true });
	assert.deepEqual(await deliver("jane@partner.test", "spam"), { status: "spam", awaiting: false });
	assert.deepEqual(await deliver("jane@partner.test", "archived"), { status: "archived", awaiting: false });
	assert.deepEqual(await deliver("b@example.com"), { status: "received", awaiting: false }, "own mailbox");
	assert.deepEqual(await deliver("sales@example.com"), { status: "received", awaiting: false }, "own alias");
	assert.deepEqual(await deliver("MAILER-DAEMON@partner.test"), { status: "received", awaiting: false });
	assert.deepEqual(await deliver("not an address"), { status: "received", awaiting: false });

	await settings.recordSenderDecision(db, {
		mailboxId: "mailbox-a",
		address: "jane@partner.test",
		decision: "approved",
		source: "manual",
		userId: "owner",
	});
	assert.deepEqual(await deliver("jane@partner.test"), { status: "received", awaiting: false });
	await settings.recordSenderDecision(db, {
		mailboxId: "mailbox-a",
		address: "jane@partner.test",
		decision: "denied",
		source: "manual",
		userId: "owner",
	});
	assert.deepEqual(await deliver("jane@partner.test"), { status: "spam", awaiting: false });

	await settings.saveScreenerSettings(db, "mailbox-a", { mode: "inbox" }, "owner");
	assert.deepEqual(await deliver("new@partner.test"), { status: "received", awaiting: true });
	await settings.saveScreenerSettings(db, "mailbox-a", { enabled: false }, "owner");
	assert.deepEqual(await deliver("new@partner.test"), { status: "received", awaiting: false }, "off ignores the flag");
	assert.deepEqual(await settings.saveScreenerSettings(db, "mailbox-b", { enabled: true }, "owner"), {
		enabled: true,
		mode: "screener",
	});
});

test("approving releases the sender's held mail, and its undo puts exactly that mail back", async (t) => {
	const { db, addMessage, statusOf, access } = await setup(t);
	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	const held = [
		addMessage("Jane <jane@partner.test>", { status: "screening" }),
		addMessage("jane@partner.test", { status: "screening" }),
	];
	const other = addMessage("bob@partner.test", { status: "screening" });
	globalThis.__screenerScheduled = [];
	const result = await service.approveSender(globalThis.__kiteNodeEnv, owner, await access(), "jane@partner.test");
	assert.deepEqual(result.movedMessageIds.sort(), [...held].sort());
	assert.equal(result.decision, "approved");
	assert.deepEqual(globalThis.__screenerScheduled.sort(), [...held].sort(), "released mail is read automatically now");
	for (const id of held) assert.equal(statusOf(id), "received");
	assert.equal(statusOf(other), "screening");
	assert.equal(await settings.getSenderDecision(db, "mailbox-a", "jane@partner.test"), "approved");

	const undone = await service.removeSenderDecision(
		globalThis.__kiteNodeEnv,
		owner,
		await access(),
		"jane@partner.test",
		[...result.movedMessageIds, other],
	);
	assert.deepEqual(undone, { removed: true, restored: 2 });
	for (const id of held) assert.equal(statusOf(id), "screening");
	assert.equal(await settings.getSenderDecision(db, "mailbox-a", "jane@partner.test"), null);
	assert.deepEqual(
		await service.removeSenderDecision(globalThis.__kiteNodeEnv, owner, await access(), "jane@partner.test"),
		{
			removed: false,
			restored: 0,
		},
	);
});

test("Undo preserves and restores more than 500 released message IDs", async (t) => {
	const { db, env, addMessage, statusOf, access } = await setup(t);
	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	const held = Array.from({ length: 551 }, () => addMessage("jane@partner.test", { status: "screening" }));
	const other = addMessage("bob@partner.test");
	const approved = await service.approveSender(env, owner, await access(), "jane@partner.test");
	const parsed = utils.parseScreenerSenderRemoval({
		mailboxId: "mailbox-a",
		address: "jane@partner.test",
		restoreMessageIds: [...approved.movedMessageIds, held[0], other, "", null],
	});
	assert.equal(parsed.ok, true);
	assert.equal(parsed.value.restoreMessageIds.length, held.length + 1);
	const undone = await service.removeSenderDecision(
		env,
		owner,
		await access(),
		parsed.value.address,
		parsed.value.restoreMessageIds,
	);
	assert.deepEqual(undone, { removed: true, restored: held.length });
	for (const id of held) assert.equal(statusOf(id), "screening");
	assert.equal(statusOf(other), "received", "Undo cannot restore another sender's mail");
});

test("denying moves waiting mail to Spam, trains on it and blocks the sender until the denial is removed", async (t) => {
	const { database, db, env, addMessage, statusOf, access } = await setup(t);
	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	const held = addMessage("spammer@junk.test", { status: "screening" });
	const result = await service.denySender(env, owner, await access(), "spammer@junk.test");
	assert.deepEqual(result, {
		address: "spammer@junk.test",
		decision: "denied",
		movedMessageIds: [held],
		blocked: true,
	});
	assert.equal(statusOf(held), "spam");
	assert.equal(
		database.db.prepare("SELECT classification FROM spam_feedback WHERE message_id = ?").get(held).classification,
		"spam",
	);
	const rule = () =>
		database.db.prepare("SELECT action FROM routing_rules WHERE id = 'block:mailbox-a:spammer@junk.test'").get();
	assert.equal(rule().action, "trash");
	assert.deepEqual(
		await applyScreener(db, { mailboxId: "mailbox-a", sender: "spammer@junk.test", status: "received" }),
		{
			status: "spam",
			awaiting: false,
		},
	);

	await service.removeSenderDecision(env, owner, await access(), "spammer@junk.test");
	assert.equal(rule(), undefined);
	assert.equal(database.db.prepare("SELECT blocked FROM contacts WHERE email = 'spammer@junk.test'").get().blocked, 0);

	await service.denySender(env, owner, await access(), "spammer@junk.test");
	await service.approveSender(env, owner, await access(), "spammer@junk.test");
	assert.equal(rule(), undefined, "approving a denied sender lifts the block");
});

test("in Inbox mode approving and denying act on the marked Inbox mail too", async (t) => {
	const { db, env, addMessage, statusOf, access } = await setup(t);
	await settings.saveScreenerSettings(db, "mailbox-a", { enabled: true, mode: "inbox" }, "owner");
	const marked = addMessage("jane@partner.test");
	const deniedMail = addMessage("spammer@junk.test");
	const pending = await views.screenerPendingRows(db, [
		{ id: marked, mailboxId: "mailbox-a", status: "received", direction: "inbound", fromAddr: "jane@partner.test" },
		{ id: "own", mailboxId: "mailbox-a", status: "received", direction: "inbound", fromAddr: "b@example.com" },
		{ id: "held", mailboxId: "mailbox-b", status: "screening", direction: "inbound", fromAddr: "x@partner.test" },
		{ id: "off", mailboxId: "mailbox-b", status: "received", direction: "inbound", fromAddr: "x@partner.test" },
	]);
	assert.deepEqual([...pending].sort(), ["held", marked].sort());
	const status = await views.getScreenerMessageStatus(db, owner, marked);
	assert.deepEqual(status, {
		address: "jane@partner.test",
		mailboxId: "mailbox-a",
		mode: "inbox",
		canManage: true,
		pending: true,
	});

	const approved = await service.approveSender(env, owner, await access(), "jane@partner.test");
	assert.deepEqual(approved.movedMessageIds, [], "marked mail is already in the Inbox");
	assert.equal(statusOf(marked), "received");
	assert.equal((await views.getScreenerMessageStatus(db, owner, marked)).pending, false);
	await service.denySender(env, owner, await access(), "spammer@junk.test");
	assert.equal(statusOf(deniedMail), "spam");
});

test("inbound retries skip held and marked mail until the sender is approved", async (t) => {
	const { database, db, env, addMessage } = await setup(t);
	await settings.saveScreenerSettings(db, "mailbox-a", { enabled: true, mode: "inbox" }, "owner");
	const held = addMessage("held@partner.test", { status: "screening" });
	const marked = addMessage("marked@partner.test");
	const retry = async (id) => {
		const rawR2Key = `raw/${id}.eml`;
		database.db.prepare("UPDATE messages SET raw_r2_key = ? WHERE id = ?").run(rawR2Key, id);
		await processInboundMessage(env, { from: "envelope@partner.test", to: "a@example.com", rawR2Key });
	};
	globalThis.__screenerScheduled = [];
	await retry(held);
	await retry(marked);
	assert.deepEqual(globalThis.__screenerScheduled, []);
	await settings.recordSenderDecision(db, {
		mailboxId: "mailbox-a",
		address: "marked@partner.test",
		decision: "approved",
		source: "manual",
		userId: "owner",
	});
	await retry(marked);
	assert.deepEqual(globalThis.__screenerScheduled, [marked]);
	await settings.saveScreenerSettings(db, "mailbox-a", { enabled: false }, "owner");
	const plain = addMessage("plain@partner.test");
	await retry(plain);
	assert.deepEqual(globalThis.__screenerScheduled, [marked, plain]);
});

test("sending approves the recipients the mailbox has not decided on, and releases their held mail", async (t) => {
	const { db, env, addMessage, statusOf } = await setup(t);
	await approveSentRecipients(env, "mailbox-a", "owner", ["jane@partner.test"]);
	assert.equal(await settings.getSenderDecision(db, "mailbox-a", "jane@partner.test"), null, "off: nothing happens");

	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	const held = addMessage("jane@partner.test", { status: "screening" });
	globalThis.__screenerScheduled = [];
	await settings.recordSenderDecision(db, {
		mailboxId: "mailbox-a",
		address: "spammer@junk.test",
		decision: "denied",
		source: "manual",
		userId: "owner",
	});
	await approveSentRecipients(env, "mailbox-a", "owner", [
		"Jane <jane@partner.test>",
		"spammer@junk.test",
		"b@example.com",
		"carol@partner.test, dave@partner.test",
	]);
	assert.equal(statusOf(held), "received");
	assert.deepEqual(globalThis.__screenerScheduled, [], "a reply released it, so no reply suggestion is made");
	const senders = await settings.listScreenerSenders(db, "mailbox-a");
	assert.deepEqual(
		senders.map((entry) => [entry.address, entry.decision, entry.source]),
		[
			["carol@partner.test", "approved", "sent"],
			["dave@partner.test", "approved", "sent"],
			["jane@partner.test", "approved", "sent"],
			["spammer@junk.test", "denied", "manual"],
		],
	);
	await approveSentRecipients(env, "missing", "owner", ["x@partner.test"]);
});

test("approving everyone written to covers past sent mail once, in chunks", async (t) => {
	const { db, env, addMessage, statusOf, access } = await setup(t);
	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	for (let index = 0; index < 23; index += 1)
		addMessage("a@example.com", { direction: "outbound", status: "sent", to: `friend${index}@partner.test` });
	addMessage("a@example.com", { direction: "outbound", status: "draft", to: "draft@partner.test" });
	const held = addMessage("friend3@partner.test", { status: "screening" });
	const result = await service.approveEveryoneWrittenTo(env, owner, await access());
	assert.deepEqual(result, { approved: 23, released: 1 });
	assert.equal(statusOf(held), "received");
	assert.equal(await settings.getSenderDecision(db, "mailbox-a", "draft@partner.test"), null);
	assert.deepEqual(await service.approveEveryoneWrittenTo(env, owner, await access()), { approved: 0, released: 0 });
});

test("the overview and the reader status show read-only users the state without letting them act", async (t) => {
	const { db, addMessage, access } = await setup(t);
	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	const held = addMessage("jane@partner.test", { status: "screening" });
	const overview = await views.getScreenerOverview(db, await access(reader));
	assert.deepEqual(overview, {
		available: true,
		canManage: false,
		settings: { enabled: true, mode: "screener" },
		approved: [],
		denied: [],
		waiting: 1,
	});
	assert.deepEqual(await views.getScreenerMessageStatus(db, reader, held), {
		address: "jane@partner.test",
		mailboxId: "mailbox-a",
		mode: "screener",
		canManage: false,
		pending: true,
	});
	const stranger = { id: "stranger", role: "user", isPrimaryAdmin: false, email: "s@example.com" };
	assert.equal(await views.getScreenerMessageStatus(db, stranger, held), null);
	assert.equal(await views.getScreenerMessageStatus(db, owner, "missing"), null);
	const plain = addMessage("jane@partner.test");
	assert.equal((await views.getScreenerMessageStatus(db, owner, plain)).pending, false);
});

test("before migration 0067 every read answers off and every write says the migration is missing", async (t) => {
	const { db, env, addMessage, statusOf, access } = await setup(t, { migrated: false });
	assert.equal(await settings.isScreenerAvailable(db), false);
	assert.equal(await settings.getScreenerSettings(db, "mailbox-a"), null);
	assert.equal((await settings.listScreenerSettings(db, ["mailbox-a"])).size, 0);
	assert.equal((await settings.listScreenerSettings(db, [])).size, 0);
	assert.equal(await settings.getSenderDecision(db, "mailbox-a", "jane@partner.test"), null);
	assert.deepEqual(await settings.listScreenerSenders(db, "mailbox-a"), []);
	assert.equal((await settings.listDecidedAddresses(db, ["mailbox-a"], ["jane@partner.test"])).size, 0);
	await settings.enableScreenerForNewMailbox(db, "mailbox-a");
	assert.deepEqual(
		await applyScreener(db, { mailboxId: "mailbox-a", sender: "jane@partner.test", status: "received" }),
		{
			status: "received",
			awaiting: false,
		},
	);
	const id = addMessage("jane@partner.test");
	assert.deepEqual(
		[
			...(await views.screenerPendingRows(db, [
				{ id, mailboxId: "mailbox-a", status: "received", direction: "inbound", fromAddr: "jane@partner.test" },
			])),
		],
		[],
	);
	await approveSentRecipients(env, "mailbox-a", "owner", ["jane@partner.test"]);
	assert.equal(statusOf(id), "received");
	const overview = await views.getScreenerOverview(db, await access());
	assert.equal(overview.available, false);
	assert.deepEqual(overview.settings, { enabled: false, mode: "screener" });
	await assert.rejects(
		settings.saveScreenerSettings(db, "mailbox-a", { enabled: true }, "owner"),
		settings.ScreenerUnavailableError,
	);
	await assert.rejects(
		service.approveSender(env, owner, await access(), "jane@partner.test"),
		settings.ScreenerUnavailableError,
	);
	await assert.rejects(
		settings.deleteSenderDecision(db, "mailbox-a", "jane@partner.test"),
		settings.ScreenerUnavailableError,
	);
});
