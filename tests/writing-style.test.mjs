import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-writing-style-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		style: fileURLToPath(import.meta.resolve("../src/lib/agent/writing-style.ts")),
		queue: fileURLToPath(import.meta.resolve("../src/lib/agent/queue.ts")),
		db: join(root, "src/db/index.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const style = await load("style");
const { processAgentQueueMessage } = await load("queue");
const { createDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const OWNER = { id: "owner", email: "alex@example.com", role: "user", name: "Alex", disabled: false };
let messageCount = 0;

async function setup(t, { enabled = true, behind = false } = {}) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'alex@example.com', 'hash', 'Alex', 1), ('other', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'alex', 'personal', 1), ('mailbox-b', 'owner', 'domain-1', 'sales', 'shared', 1);
		INSERT INTO user_ai_settings (user_id, writing_style_enabled, updated_at) VALUES ('owner', ${enabled ? 1 : 0}, 1);
	`);
	if (behind) sqlite.db.exec("DROP TABLE composer_sends; DROP TABLE writing_style_profiles;");
	const sent = [];
	const env = { DB: sqlite, AGENT_QUEUE: { send: async (message) => sent.push(message) } };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { sqlite, db: createDb(sqlite), env, sent };
}

const HTML = (index) =>
	`<div>Hi Sam,</div><div><br></div><div>Thanks for the update on the plan number ${index}. Can you send me the latest figures before Friday so I can review them?</div><div><br></div><div>Cheers,</div><div data-kite-signature="1"><br><br>Alex</div>`;

function insertSent(
	sqlite,
	{ mailboxId = "mailbox-a", html = HTML(++messageCount), status = "sent", at = messageCount } = {},
) {
	const id = `msg-${++messageCount}`;
	sqlite.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, html_body, status, created_at) VALUES (?, 'owner', ?, 'outbound', 'alex@example.com', 'sam@partner.test', 'Plan', ?, ?, ?)",
		)
		.run(id, mailboxId, html, status, at);
	return id;
}

const profileRow = (sqlite, mailboxId = "mailbox-a") =>
	sqlite.db.prepare("SELECT * FROM writing_style_profiles WHERE user_id = 'owner' AND mailbox_id = ?").get(mailboxId);
const composerRows = (sqlite) => sqlite.db.prepare("SELECT * FROM composer_sends ORDER BY created_at").all();

async function send(env, sqlite, overrides = {}) {
	const messageId = insertSent(sqlite, overrides);
	await style.learnFromComposerSend(env, {
		messageId,
		userId: "owner",
		mailboxId: overrides.mailboxId ?? "mailbox-a",
		aiAssisted: overrides.aiAssisted ?? false,
		html: sqlite.db.prepare("SELECT html_body FROM messages WHERE id = ?").get(messageId).html_body,
		text: null,
	});
	return messageId;
}

test("every composer send is recorded; only an opted-in user's own text is learnt, never AI-assisted text", async (t) => {
	const { sqlite, env } = await setup(t, { enabled: false });
	await send(env, sqlite);
	assert.equal(composerRows(sqlite).length, 1, "recorded even with the opt-in off");
	assert.equal(profileRow(sqlite), undefined);
	sqlite.db.exec("UPDATE user_ai_settings SET writing_style_enabled = 1");
	await send(env, sqlite);
	const aiAssisted = await send(env, sqlite, { aiAssisted: true });
	// A send Kite helped write leaves no row: no "used Write with Kite" signal is stored without consent.
	assert.equal(composerRows(sqlite).length, 2);
	assert.equal(
		composerRows(sqlite).some((row) => row.message_id === aiAssisted),
		false,
	);
	assert.deepEqual(Object.keys(composerRows(sqlite)[0]).sort(), ["created_at", "mailbox_id", "message_id", "user_id"]);
	const row = profileRow(sqlite);
	assert.equal(row.sample_count, 1);
	assert.deepEqual(JSON.parse(row.greetings), { "hi {name},": 1 });
	assert.doesNotMatch(JSON.stringify(row), /Sam|figures|Friday|Alex|plan number/, "no text and no names are stored");
});

test("the description reaches prompts only with the opt-in on and ten samples", async (t) => {
	const { sqlite, db, env } = await setup(t);
	for (let index = 0; index < 9; index++) await send(env, sqlite);
	assert.equal(await style.styleDescriptionFor(db, "owner", "mailbox-a"), null);
	await send(env, sqlite);
	assert.match(
		await style.styleDescriptionFor(db, "owner", "mailbox-a"),
		/Opens with "hi \{name\}," and closes with "cheers,"/,
	);
	assert.equal(await style.styleDescriptionFor(db, "owner", "mailbox-b"), null, "another mailbox has its own profile");
	assert.equal(await style.styleDescriptionFor(db, "other", "mailbox-a"), null, "another user has none");
	sqlite.db.exec("UPDATE user_ai_settings SET writing_style_enabled = 0");
	assert.equal(await style.styleDescriptionFor(db, "owner", "mailbox-a"), null, "off stops using it at once");
});

test("concurrent updates never lose a sample (compare-and-set), and a stale metrics version starts over", async (t) => {
	const { sqlite, db, env } = await setup(t);
	await send(env, sqlite);
	const sample = JSON.parse(profileRow(sqlite).stats);
	assert.ok(sample.words);
	await Promise.all(Array.from({ length: 3 }, () => send(env, sqlite)));
	assert.equal(profileRow(sqlite).sample_count, 4);
	assert.ok(profileRow(sqlite).version >= 4);
	sqlite.db.exec("UPDATE writing_style_profiles SET metrics_version = 0, sample_count = 99");
	await send(env, sqlite);
	assert.equal(profileRow(sqlite).sample_count, 1);
	assert.equal(profileRow(sqlite).metrics_version, 1);
	assert.ok(await style.updateStyleProfile(db, "owner", "mailbox-a", []));
});

test("a backfill learns only from the user's own composer sends without AI text, oldest first, at most 200", async (t) => {
	const { sqlite, env, sent } = await setup(t);
	for (let index = 0; index < 12; index++) await send(env, sqlite);
	await send(env, sqlite, { aiAssisted: true });
	await send(env, sqlite, { mailboxId: "mailbox-b" });
	insertSent(sqlite); // sent through the API: no composer_sends row
	insertSent(sqlite, { status: "draft" });
	sqlite.db.exec("DELETE FROM writing_style_profiles");

	const user = { ...OWNER };
	assert.equal(await style.requestStyleBackfill(env, user, "mailbox-a"), "queued");
	assert.equal(await style.requestStyleBackfill(env, user, "mailbox-a"), "pending", "one at a time");
	assert.deepEqual(sent, [{ kind: "agent.style_backfill", userId: "owner", mailboxId: "mailbox-a" }]);
	assert.equal(await processAgentQueueMessage(env, sent[0]), true);
	const row = profileRow(sqlite);
	assert.equal(row.sample_count, 12);
	assert.equal(row.backfill_requested_at, null, "done: it can be requested again");
	assert.equal(profileRow(sqlite, "mailbox-b"), undefined);

	// A second backfill starts over instead of counting the same sends twice.
	assert.equal(await style.requestStyleBackfill(env, user, "mailbox-a"), "queued");
	await processAgentQueueMessage(env, sent[1]);
	assert.equal(profileRow(sqlite).sample_count, 12);
	assert.equal(await style.requestStyleBackfill(env, { ...OWNER, id: "other" }, "mailbox-a"), "not_found");
});

test("the list shows every mailbox the user can send from; Reset and turning off delete", async (t) => {
	const { sqlite, db, env } = await setup(t);
	for (let index = 0; index < 10; index++) await send(env, sqlite);
	const profiles = await style.listStyleProfiles(db, OWNER);
	assert.deepEqual(
		profiles.map((profile) => [profile.address, profile.sampleCount, !!profile.description]),
		[
			["alex@example.com", 10, true],
			["sales@example.com", 0, false],
		],
	);
	await style.resetStyleProfile(db, "owner", "mailbox-a");
	assert.equal(profileRow(sqlite), undefined);
	await send(env, sqlite, { mailboxId: "mailbox-b" });
	await style.deleteStyleProfiles(db, "owner");
	assert.equal(sqlite.db.prepare("SELECT count(*) AS n FROM writing_style_profiles").get().n, 0);
	assert.equal(composerRows(sqlite).length, 11, "the send records stay; they hold no text");
});

test("before migration 0070 a send still works, nothing is learnt and the profile is hidden", async (t) => {
	const { sqlite, db, env } = await setup(t, { behind: true });
	assert.equal(await style.writingStyleAvailable(env), false);
	await send(env, sqlite);
	assert.equal(await style.styleDescriptionFor(db, "owner", "mailbox-a"), null);
	await style.deleteStyleProfiles(db, "owner");
	assert.equal(await style.writingStyleAvailable((await setup(t)).env), true);
});

test("a draft Kite wrote into stays marked until it is sent or discarded", async (t) => {
	const { sqlite, db } = await setup(t);
	const draftId = insertSent(sqlite, { status: "draft" });
	assert.equal(await style.isAiAssistedDraft(db, draftId), false);
	await style.markAiAssistedDraft(db, draftId, false);
	assert.equal(await style.isAiAssistedDraft(db, draftId), false, "only a saved insert marks it");
	await style.markAiAssistedDraft(db, draftId, true);
	await style.markAiAssistedDraft(db, draftId, true);
	assert.equal(await style.isAiAssistedDraft(db, draftId), true);
	sqlite.db.prepare("DELETE FROM messages WHERE id = ?").run(draftId);
	assert.equal(await style.isAiAssistedDraft(db, draftId), false, "the mark goes with the draft");
});

/** The database, with `after` run once right after the backfill's first page wrote its samples to the profile. */
function interruptAfterFirstPage(sqlite, after) {
	let done = false;
	const watch = (statement) =>
		new Proxy(statement, {
			get(inner, name) {
				const value = Reflect.get(inner, name);
				if (typeof value !== "function") return value;
				if (name === "bind") return (...args) => watch(value.apply(inner, args));
				if (!["run", "all", "raw", "first"].includes(name)) return value.bind(inner);
				return async (...args) => {
					const result = await value.apply(inner, args);
					if (!done) {
						done = true;
						after();
					}
					return result;
				};
			},
		});
	return new Proxy(sqlite, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (key !== "prepare") return typeof value === "function" ? value.bind(target) : value;
			return (query) => {
				const statement = value.call(target, query);
				return !done && /^update "writing_style_profiles" set "metrics_version"/i.test(query)
					? watch(statement)
					: statement;
			};
		},
	});
}

for (const [label, interrupt] of [
	["Reset", (sqlite) => sqlite.db.exec("DELETE FROM writing_style_profiles")],
	[
		"Switching off",
		(sqlite) =>
			sqlite.db.exec("UPDATE user_ai_settings SET writing_style_enabled = 0; DELETE FROM writing_style_profiles"),
	],
])
	test(`${label} during a backfill ends it, and no profile comes back`, async (t) => {
		const { sqlite, env, sent } = await setup(t);
		for (let index = 0; index < 120; index++) await send(env, sqlite);
		assert.equal(await style.requestStyleBackfill(env, { ...OWNER }, "mailbox-a"), "queued");
		let interrupted = false;
		const db = interruptAfterFirstPage(sqlite, () => {
			interrupted = true;
			interrupt(sqlite);
		});
		await style.processStyleBackfill({ ...env, DB: db }, sent[0]);
		assert.equal(interrupted, true, "the job was interrupted after its first page");
		assert.equal(profileRow(sqlite), undefined);
	});
