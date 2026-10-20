import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	FileBucket,
	getDriveRole,
	getDriveChain,
	getDriveItem,
	collectDriveDescendants,
	subtreeHeight,
	hiddenFolderIds,
	answerDrive,
	reserveDriveFile,
	getQuotaLimit,
	getDriveUsage,
	createFolder,
	updateItem,
	bulkItems,
	deleteItemForever,
	getItemDetails,
	listDriveItems,
	startUpload,
	putUploadPart,
	completeUpload,
	abortUpload,
	streamDriveFile,
	purgeDrive,
	createLink,
	revokeLink,
	resolvePublicLink,
	addShare,
	getShares,
	saveDriveSettings,
	clearModuleStateCache,
	getDb,
} = await bundleModules("kite-drive-access-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["FileBucket", "server/runtime/file-bucket.ts"],
	[
		"getDriveRole, getDriveChain, getDriveItem, collectDriveDescendants, subtreeHeight, hiddenFolderIds",
		"src/lib/drive/access.ts",
	],
	["answerDrive", "src/lib/drive/errors.ts"],
	["reserveDriveFile, getQuotaLimit, getDriveUsage, saveDriveSettings", "src/lib/drive/quota.ts"],
	["createFolder, updateItem, bulkItems, deleteItemForever, getItemDetails", "src/lib/drive/items.ts"],
	["listDriveItems", "src/lib/drive/listing.ts"],
	["startUpload, putUploadPart, completeUpload, abortUpload", "src/lib/drive/uploads.ts"],
	["streamDriveFile", "src/lib/drive/content.ts"],
	["purgeDrive", "src/lib/drive/retention.ts"],
	["createLink, revokeLink", "src/lib/drive/links.ts"],
	["resolvePublicLink", "src/lib/drive/public.ts"],
	["addShare, getShares", "src/lib/drive/shares.ts"],
	["clearModuleStateCache", "src/lib/modules/state.ts"],
	["getDb", "src/db/index.ts"],
]);

const scratch = makeBundleDirectory("kite-drive-access-buckets-");
after(() => rmSync(scratch, { recursive: true, force: true }));
let bucketCount = 0;

const OWNER = { id: "owner", email: "owner@example.com", name: "Owner", role: "admin", isPrimaryAdmin: true };
const MEMBER = { id: "member", email: "member@example.com", name: "Member", role: "user", isPrimaryAdmin: false };
const DAY = 24 * 60 * 60 * 1000;
const sec = (ms) => Math.floor(ms / 1000);

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	db.db.exec("PRAGMA foreign_keys = ON");
	clearModuleStateCache();
	const env = { DB: db, BUCKET: new FileBucket(join(scratch, `bucket-${++bucketCount}`)) };
	return { db, env };
}

const run = (env, operation) => answerDrive(env, operation);

/** Inserts rows directly: `[id, ownerId, parentId, kind, extra]`. */
function insert(db, rows) {
	const statement = db.db.prepare(
		`INSERT INTO drive_items (id, owner_id, parent_id, kind, name, size, status, store_id, object_key, trashed_at, created_at, updated_at)
		VALUES (@id, @owner, @parent, @kind, @name, @size, @status, @store, @key, @trashed, @at, @at)`,
	);
	for (const [id, owner, parent, kind, extra = {}] of rows)
		statement.run({
			id,
			owner,
			parent,
			kind,
			name: extra.name ?? id,
			size: extra.size ?? 0,
			status: extra.status ?? "ready",
			store: kind === "file" ? "default" : null,
			key: kind === "file" ? `drive/${id}` : null,
			trashed: extra.trashed ?? null,
			at: extra.at ?? 100,
		});
}

const share = (db, id, itemId, userId, role) =>
	db.db
		.prepare(
			"INSERT INTO drive_shares (id, item_id, user_id, role, created_by_user_id, created_at) VALUES (?, ?, ?, ?, 'owner', 1)",
		)
		.run(id, itemId, userId, role);

/** Plans/ > Q1/ > report.pdf, plus a loose file at the top. */
function seedTree(db) {
	insert(db, [
		["plans", "owner", null, "folder"],
		["q1", "owner", "plans", "folder"],
		["report", "owner", "q1", "file", { size: 10 }],
		["loose", "owner", null, "file", { size: 5 }],
	]);
}

const roleOf = async (env, userId, id, options) =>
	(await getDriveRole(getDb(env), userId, await getDriveItem(getDb(env), id), options)).role;

test("a share on a folder reaches everything below it, and the highest share wins", async (t) => {
	const { db, env } = await setup(t);
	seedTree(db);
	assert.equal(await roleOf(env, "owner", "report"), "owner");
	assert.equal(await roleOf(env, "member", "report"), null);
	share(db, "s1", "plans", "member", "view");
	assert.equal(await roleOf(env, "member", "report"), "view");
	assert.equal(await roleOf(env, "member", "loose"), null);
	share(db, "s2", "q1", "member", "edit");
	assert.equal(await roleOf(env, "member", "report"), "edit");
	assert.equal(await roleOf(env, "member", "plans"), "view");
	const chain = await getDriveChain(getDb(env), await getDriveItem(getDb(env), "report"));
	assert.deepEqual(
		chain.map((row) => row.id),
		["plans", "q1", "report"],
	);
});

test("a trashed ancestor hides the subtree, except for the owner's trash view", async (t) => {
	const { db, env } = await setup(t);
	seedTree(db);
	share(db, "s1", "plans", "member", "edit");
	db.db.exec("UPDATE drive_items SET trashed_at = 200 WHERE id = 'plans'");
	assert.equal(await roleOf(env, "member", "report"), null);
	assert.equal(await roleOf(env, "owner", "report"), null);
	assert.equal(await roleOf(env, "owner", "report", { allowTrashed: true }), "owner");
	assert.deepEqual([...(await hiddenFolderIds(env, ["q1", "plans"]))].sort(), ["plans", "q1"]);
	assert.deepEqual([...(await hiddenFolderIds(env, []))], []);
});

test("uploads in progress are invisible except to the upload routes", async (t) => {
	const { db, env } = await setup(t);
	insert(db, [["partial", "owner", null, "file", { status: "uploading", size: 3 }]]);
	assert.equal(await roleOf(env, "owner", "partial"), null);
	assert.equal(await roleOf(env, "owner", "partial", { allowUploading: true }), "owner");
});

test("a parent cycle in restored data ends instead of looping", async (t) => {
	const { db, env } = await setup(t);
	insert(db, [
		["a", "owner", "b", "folder"],
		["b", "owner", "a", "folder"],
	]);
	const chain = await getDriveChain(getDb(env), await getDriveItem(getDb(env), "a"));
	assert.deepEqual(chain.map((row) => row.id).sort(), ["a", "b"]);
	assert.ok((await collectDriveDescendants(getDb(env), ["a"])).length <= 1);
	assert.ok((await subtreeHeight(env, "a")) <= 64);
});

test("descendants and subtree height come from one recursive query", async (t) => {
	const { db, env } = await setup(t);
	seedTree(db);
	assert.deepEqual((await collectDriveDescendants(getDb(env), ["plans"])).map((row) => row.id).sort(), [
		"q1",
		"report",
	]);
	assert.equal(await subtreeHeight(env, "plans"), 2);
	assert.equal(await subtreeHeight(env, "report"), 0);
});

test("the quota reservation is atomic, honours overrides and lets unlimited owners through", async (t) => {
	const { db, env } = await setup(t);
	const file = (id, size) => ({
		id,
		ownerId: "member",
		parentId: null,
		name: id,
		size,
		contentType: "text/plain",
		storeId: "default",
		objectKey: `drive/${id}`,
		uploadPartSize: null,
		uploadFingerprint: null,
		uploadExpiresAt: null,
		sourceAttachmentId: null,
		now: new Date(),
	});
	assert.equal(await getQuotaLimit(env, "member"), null);
	assert.equal(await reserveDriveFile(env, file("big", 1e12), null), true, "no limit, no check");
	db.db.exec("DELETE FROM drive_items");
	await saveDriveSettings(env, { defaultQuotaBytes: 100, linkMaxDays: 30, trashRetentionDays: 30 }, "owner");
	assert.equal(await getQuotaLimit(env, "member"), 100);
	assert.equal(await reserveDriveFile(env, file("f1", 60), 100), true);
	assert.equal(await reserveDriveFile(env, file("f2", 41), 100), false, "would overshoot");
	assert.equal(await reserveDriveFile(env, file("f3", 40), 100), true, "exactly full");
	assert.deepEqual(await getDriveUsage(env, "member"), { used: 100, limit: 100 });
	db.db.exec("INSERT INTO drive_user_quotas (user_id, quota_bytes, updated_at) VALUES ('member', NULL, 1)");
	assert.equal(await getQuotaLimit(env, "member"), null, "an override of null is unlimited");
	db.db.exec("UPDATE drive_user_quotas SET quota_bytes = 200");
	assert.equal(await getQuotaLimit(env, "member"), 200);
	assert.equal(await getQuotaLimit(env, "owner"), 100);
});

test("folders, renames and moves: never into itself, across owners or out of a share by an editor", async (t) => {
	const { db, env } = await setup(t);
	seedTree(db);
	const created = await run(env, () => createFolder(env, OWNER, { name: " Q2 ", parentId: "plans" }));
	assert.equal(created.status, 201);
	assert.equal(created.body.item.name, "Q2");
	assert.equal((await run(env, () => createFolder(env, OWNER, { name: "/" }))).status, 400);
	assert.equal((await run(env, () => createFolder(env, MEMBER, { name: "x", parentId: "plans" }))).status, 404);

	assert.equal((await run(env, () => updateItem(env, OWNER, "plans", { parentId: "q1" }))).status, 400);
	assert.equal((await run(env, () => updateItem(env, OWNER, "report", { parentId: null }))).status, 200);
	assert.equal((await getDriveItem(getDb(env), "report")).parentId, null);

	insert(db, [["mine", "member", null, "folder"]]);
	assert.equal((await run(env, () => updateItem(env, OWNER, "loose", { parentId: "mine" }))).status, 404);
	share(db, "s1", "plans", "member", "edit");
	const crossOwner = await run(env, () => bulkItems(env, MEMBER, { ids: ["q1"], action: "move", parentId: "mine" }));
	assert.equal(crossOwner.status, 400);
	const toRoot = await run(env, () => updateItem(env, MEMBER, "q1", { parentId: null }));
	assert.equal(toRoot.status, 403);
	assert.equal((await run(env, () => updateItem(env, MEMBER, "q1", { name: "Quarter 1" }))).status, 200);
	const details = await run(env, () => getItemDetails(env, MEMBER, "q1"));
	assert.equal(details.body.role, "edit");
	assert.deepEqual(
		details.body.path.map((crumb) => crumb.name),
		["Quarter 1"],
		"a person it is shared with sees no path above the item",
	);
});

test("folders cannot nest deeper than 64 levels", async (t) => {
	const { db, env } = await setup(t);
	const rows = [];
	for (let level = 0; level < 64; level += 1)
		rows.push([`f${level}`, "owner", level ? `f${level - 1}` : null, "folder"]);
	insert(db, rows);
	assert.equal((await run(env, () => createFolder(env, OWNER, { name: "deep", parentId: "f63" }))).status, 400);
	insert(db, [["other", "owner", null, "folder"]]);
	assert.equal((await run(env, () => updateItem(env, OWNER, "f0", { parentId: "other" }))).status, 400);
});

test("trash, restore and delete forever; an orphan comes back at the top level", async (t) => {
	const { db, env } = await setup(t);
	seedTree(db);
	const picker = await run(env, () =>
		listDriveItems(env, OWNER, { view: "my", parentId: null, query: "", types: [], foldersOnly: true, cursor: null }),
	);
	assert.ok(picker.body.items.length > 0);
	assert.ok(
		picker.body.items.every((item) => item.kind === "folder"),
		"a folder picker lists folders only",
	);
	assert.equal((await run(env, () => bulkItems(env, OWNER, { ids: ["report"], action: "trash" }))).body.count, 1);
	assert.equal((await run(env, () => bulkItems(env, OWNER, { ids: ["plans"], action: "trash" }))).body.count, 1);
	const trash = await run(env, () =>
		listDriveItems(env, OWNER, {
			view: "trash",
			parentId: null,
			query: "",
			types: [],
			foldersOnly: false,
			cursor: null,
		}),
	);
	assert.deepEqual(trash.body.items.map((item) => item.id).sort(), ["plans", "report"]);
	assert.equal((await run(env, () => bulkItems(env, OWNER, { ids: ["report"], action: "restore" }))).status, 200);
	assert.equal((await getDriveItem(getDb(env), "report")).parentId, null, "its folder is still in the trash");
	assert.equal((await run(env, () => deleteItemForever(env, OWNER, "loose"))).status, 409);
	assert.equal((await run(env, () => deleteItemForever(env, MEMBER, "plans"))).status, 404);
	assert.equal((await run(env, () => deleteItemForever(env, OWNER, "plans"))).body.count, 2);
	assert.equal(await getDriveItem(getDb(env), "q1"), null);
	assert.equal((await run(env, () => bulkItems(env, OWNER, { ids: [], action: "trash" }))).status, 400);
	assert.equal((await run(env, () => bulkItems(env, OWNER, { ids: ["nope"], action: "trash" }))).status, 404);
});

test("listing pages by cursor, searches by name and shows what is shared with the member", async (t) => {
	const { db, env } = await setup(t);
	const rows = [];
	for (let index = 0; index < 105; index += 1)
		rows.push([
			`f${String(index).padStart(3, "0")}`,
			"owner",
			null,
			"file",
			{ at: 1000 + index, name: `n${index}.txt` },
		]);
	insert(db, rows);
	const query = { view: "recent", parentId: null, query: "", types: [], foldersOnly: false, cursor: null };
	const first = await run(env, () => listDriveItems(env, OWNER, query));
	assert.equal(first.body.items.length, 100);
	assert.ok(first.body.nextCursor);
	const { decodeDriveCursor } = await bundleModules("kite-drive-access-cursor-", [
		["decodeDriveCursor", "src/lib/drive/list-utils.ts"],
	]);
	const second = await run(env, () =>
		listDriveItems(env, OWNER, { ...query, cursor: decodeDriveCursor(first.body.nextCursor) }),
	);
	assert.equal(second.body.items.length, 5);
	assert.equal(second.body.nextCursor, null);
	const ids = new Set([...first.body.items, ...second.body.items].map((item) => item.id));
	assert.equal(ids.size, 105, "no row is skipped or repeated");
	const found = await run(env, () => listDriveItems(env, OWNER, { ...query, view: "my", query: "n10" }));
	assert.ok(found.body.items.every((item) => item.name.includes("n10")));
	share(db, "s1", "f000", "member", "view");
	const shared = await run(env, () => listDriveItems(env, MEMBER, { ...query, view: "shared" }));
	assert.deepEqual(
		shared.body.items.map((item) => [item.id, item.role, item.ownerName]),
		[["f000", "view", "Owner"]],
	);
});

test("a proxied upload streams its parts, completes, and serves ranges", async (t) => {
	const { env } = await setup(t);
	const body = { name: "notes.txt", size: 10, contentType: "text/plain", parentId: null, fingerprint: "fp-1" };
	const started = await run(env, () => startUpload(env, OWNER, body));
	assert.equal(started.status, 200);
	assert.equal(started.body.parts, 1);
	assert.equal(started.body.mode, "proxied");
	const again = await run(env, () => startUpload(env, OWNER, body));
	assert.equal(again.body.id, started.body.id, "the same file resumes");
	assert.equal(again.body.resumed, true);
	const part = (bytes, length = bytes.length) =>
		new Request("https://kite.test/", {
			method: "PUT",
			body: bytes,
			headers: { "content-length": String(length) },
			duplex: "half",
		});
	const id = started.body.id;
	assert.equal((await run(env, () => putUploadPart(env, OWNER, id, 1, part(new Uint8Array(4))))).status, 400);
	assert.equal((await run(env, () => putUploadPart(env, OWNER, id, 2, part(new Uint8Array(10))))).status, 400);
	assert.equal((await run(env, () => putUploadPart(env, MEMBER, id, 1, part(new Uint8Array(10))))).status, 404);
	assert.equal((await run(env, () => completeUpload(env, OWNER, id))).status, 409, "no parts yet");
	const bytes = new TextEncoder().encode("0123456789");
	assert.equal((await run(env, () => putUploadPart(env, OWNER, id, 1, part(bytes)))).status, 200);
	const done = await run(env, () => completeUpload(env, OWNER, id));
	assert.equal(done.status, 200);
	assert.equal(done.body.item.size, 10);
	const item = await getDriveItem(getDb(env), id);
	assert.equal(item.status, "ready");
	assert.equal(item.storeId, "default");
	assert.equal(item.objectKey, `drive/${id}`);
	const whole = await streamDriveFile(env, new Request("https://kite.test/"), item, false);
	assert.equal(await whole.text(), "0123456789");
	const ranged = await streamDriveFile(
		env,
		new Request("https://kite.test/", { headers: { Range: "bytes=2-4" } }),
		item,
		true,
	);
	assert.equal(ranged.status, 206);
	assert.equal(ranged.headers.get("Content-Range"), "bytes 2-4/10");
	assert.equal(await ranged.text(), "234");
	const bad = await streamDriveFile(
		env,
		new Request("https://kite.test/", { headers: { Range: "bytes=20-" } }),
		item,
		true,
	);
	assert.equal(bad.status, 416);
	await env.BUCKET.delete(item.objectKey);
	const missing = await streamDriveFile(env, new Request("https://kite.test/"), item, false);
	assert.equal(missing.status, 404);
	assert.match((await missing.json()).error, /not in storage/);
});

test("empty files are stored at once; quota and the in-progress cap refuse new uploads", async (t) => {
	const { db, env } = await setup(t);
	const empty = await run(env, () => startUpload(env, MEMBER, { name: "empty.txt", size: 0 }));
	assert.equal(empty.body.complete, true);
	assert.equal(empty.body.item.size, 0);
	await saveDriveSettings(env, { defaultQuotaBytes: 5, linkMaxDays: 30, trashRetentionDays: 30 }, "owner");
	const over = await run(env, () => startUpload(env, MEMBER, { name: "big.bin", size: 6 }));
	assert.equal(over.status, 413);
	await saveDriveSettings(env, { defaultQuotaBytes: null, linkMaxDays: 30, trashRetentionDays: 30 }, "owner");
	const rows = [];
	for (let index = 0; index < 20; index += 1)
		rows.push([`up${index}`, "member", null, "file", { status: "uploading", size: 1 }]);
	insert(db, rows);
	assert.equal((await run(env, () => startUpload(env, MEMBER, { name: "one-more", size: 1 }))).status, 429);
	const started = await run(env, () => startUpload(env, OWNER, { name: "cancel-me", size: 3 }));
	assert.equal((await run(env, () => abortUpload(env, OWNER, started.body.id))).status, 200);
	assert.equal(await getDriveItem(getDb(env), started.body.id), null);
});

test("the daily job purges trash past retention with its files and aborts stale uploads", async (t) => {
	const { db, env } = await setup(t);
	const now = new Date("2026-06-01T00:00:00Z");
	insert(db, [
		["old", "owner", null, "folder", { trashed: sec(now.getTime() - 31 * DAY) }],
		["inside", "owner", "old", "file", { size: 3 }],
		["recent", "owner", null, "file", { size: 3, trashed: sec(now.getTime() - 2 * DAY) }],
		["stale", "owner", null, "file", { status: "uploading", size: 3, at: sec(now.getTime() - 4 * DAY) }],
		["live", "owner", null, "file", { status: "uploading", size: 3, at: sec(now.getTime() - DAY) }],
	]);
	await env.BUCKET.put("drive/inside", "abc");
	assert.deepEqual(await purgeDrive(env, now), { trashed: 2, uploads: 1 });
	const left = db.db.prepare("SELECT id FROM drive_items ORDER BY id").all();
	assert.deepEqual(
		left.map((row) => row.id),
		["live", "recent"],
	);
	assert.equal(await env.BUCKET.get("drive/inside"), null);
	await saveDriveSettings(env, { defaultQuotaBytes: null, linkMaxDays: 30, trashRetentionDays: 1 }, "owner");
	assert.deepEqual(await purgeDrive(env, now), { trashed: 1, uploads: 0 });
});

test("public links: the subtree only, re-checked on every visit, never after revoke or with links off", async (t) => {
	const { db, env } = await setup(t);
	seedTree(db);
	const origin = "https://kite.test";
	assert.equal((await run(env, () => createLink(env, OWNER, "q1", {}, origin))).status, 400, "expiry required");
	assert.equal((await run(env, () => createLink(env, MEMBER, "q1", { expiresInDays: 1 }, origin))).status, 404);
	const created = await run(env, () => createLink(env, OWNER, "q1", { expiresInDays: 7 }, origin));
	assert.equal(created.status, 201);
	const token = created.body.link.url.slice(`${origin}/d/`.length);
	assert.equal(token.length, 43);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM drive_links WHERE token_hash = ?").get(token).n, 0);
	assert.equal(created.body.link.url, `${origin}/d/${token}`);
	const listed = db.db.prepare("SELECT token_sealed FROM drive_links").get();
	assert.equal(listed.token_sealed, null, "without APP_ENCRYPTION_KEY the token is not kept");

	assert.equal((await resolvePublicLink(env, token, null)).item.id, "q1");
	assert.equal((await resolvePublicLink(env, token, "report")).item.id, "report");
	assert.equal(await resolvePublicLink(env, token, "plans"), null, "above the shared folder");
	assert.equal(await resolvePublicLink(env, token, "loose"), null, "outside the subtree");
	assert.equal(await resolvePublicLink(env, "x".repeat(43), null), null);
	assert.equal(await resolvePublicLink(env, "short", null), null);

	db.db.exec("UPDATE drive_items SET trashed_at = 5 WHERE id = 'plans'");
	assert.equal(await resolvePublicLink(env, token, null), null, "a trashed ancestor ends the link");
	db.db.exec("UPDATE drive_items SET trashed_at = NULL");
	await saveDriveSettings(env, { defaultQuotaBytes: null, linkMaxDays: 0, trashRetentionDays: 30 }, "owner");
	assert.equal(await resolvePublicLink(env, token, null), null, "links turned off");
	assert.equal((await run(env, () => createLink(env, OWNER, "q1", { expiresInDays: 1 }, origin))).status, 403);
	await saveDriveSettings(env, { defaultQuotaBytes: null, linkMaxDays: 30, trashRetentionDays: 30 }, "owner");
	db.db.exec(`UPDATE drive_links SET expires_at = ${sec(Date.now()) - 1}`);
	assert.equal(await resolvePublicLink(env, token, null), null, "expired");
	db.db.exec(`UPDATE drive_links SET expires_at = ${sec(Date.now() + DAY)}`);
	assert.ok(await resolvePublicLink(env, token, null));
	assert.equal((await run(env, () => revokeLink(env, OWNER, created.body.link.id))).status, 200);
	assert.equal(await resolvePublicLink(env, token, null), null, "revoked");
	const audit = db.db.prepare("SELECT action FROM audit_logs WHERE action = 'drive.link_created'").all();
	assert.equal(audit.length, 1);
});

test("sharing: editors share with view only, and the picker leaves out people Drive is off for", async (t) => {
	const { db, env } = await setup(t);
	seedTree(db);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('third', 'third@example.com', 'hash', 'Third', 1)",
	);
	assert.equal((await run(env, () => addShare(env, OWNER, "plans", { userId: "member", role: "edit" }))).status, 200);
	assert.equal(await roleOf(env, "member", "report"), "edit");
	const byEditor = await run(env, () => addShare(env, MEMBER, "q1", { userId: "third", role: "edit" }));
	assert.equal(byEditor.status, 403);
	assert.equal((await run(env, () => addShare(env, MEMBER, "q1", { userId: "third", role: "view" }))).status, 200);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('ua', 'third', 'drive', 0, 1)",
	);
	clearModuleStateCache();
	const shares = await run(env, () => getShares(env, OWNER, "plans"));
	assert.deepEqual(
		shares.body.candidates.map((candidate) => candidate.id),
		["member"],
	);
});
